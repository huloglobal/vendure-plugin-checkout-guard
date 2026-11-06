import { adapterFor } from '@huloglobal/vendure-licence-sdk';
import {
    CancelPaymentErrorResult, CancelPaymentResult, CreatePaymentErrorResult, CreatePaymentResult, Customer, ID, Injector, LanguageCode, Logger,
    Order, Payment, PaymentMethodHandler, RequestContext, SettlePaymentErrorResult, SettlePaymentResult, TransactionalConnection,
} from '@vendure/core';

import { formatMinor, fromStripeMinorUnits } from '../stripe-hold/hold-utils';
import { getStripeMethodForChannelId } from '../stripe-hold/stripe-key';
import { BANK_TRANSFER_HANDLER_CODE, BankDetailsArgs, buildBankTransferPublicDetails } from './bank-details';
import { DEFAULT_BANK_TRANSFER_EXPIRY_DAYS, getBankTransferRuntime, notifyBankTransferOps } from './bank-transfer-runtime';
import {
    StrayBankTransferIntent, StripeBankTransferError, cancelStripeBankTransfer, createStripeBankTransfer, describeStripeFailure,
    findStrayBankTransferIntents, isStripeTransferKnownSucceeded, stripeChannelIdOf, stripePaymentIntentIdOf,
} from './stripe-bank-transfer';

const loggerCtx = 'CheckoutGuard';

let connection: TransactionalConnection | undefined;

/**
 * Bank transfer (BACS / SEPA / wire) payment method.
 *
 * Lifecycle — a real order, not an "email us" note:
 *   1. The storefront transitions the order to ArrangingPayment and calls
 *      `addPaymentToOrder({ method: '<code of the method using this handler>' })`.
 *   2. `createPayment` returns `Authorized`, so the order is placed and lands in
 *      `PaymentAuthorized`. The bank details, reference (order code), amount and
 *      pay-by date travel in `metadata.public`, which is the only metadata slice
 *      Vendure exposes to the Shop API — the storefront renders them from
 *      `activeOrder.payments[].metadata.public` and the confirmation page shows
 *      them again while `order.state === 'PaymentAuthorized'`.
 *   3. Funds arrive → an admin marks the payment received (Vendure admin
 *      "Settle payment", or `POST /checkout-guard/bank-transfers/:paymentId/received`)
 *      → `settlePayment` succeeds → order moves to `PaymentSettled` and the
 *      host's fulfilment (key delivery etc.) runs as for any settled payment.
 *   4. No funds by the pay-by date → the premium sweep (every 6 hours, worker)
 *      cancels the payment and the order and publishes `BankTransferExpiredEvent`.
 *
 * All account details are handler args so they are editable per payment method
 * (and therefore per channel) from the admin Payment Methods screen. Nothing is
 * hard-coded here on purpose.
 *
 * With `bankTransfer.stripe.enabled` (opt-in), orders in a Stripe currency
 * (GBP by default) get a Stripe virtual account and Stripe's reference in
 * `metadata.public` instead, and step 3 happens by itself: the Stripe webhook
 * (or the ten-minute sweep) settles the payment once Stripe has matched the
 * transfer. Settling such a payment by hand, or cancelling it, also retires
 * its PaymentIntent at Stripe. Whenever Stripe cannot be used, the order gets
 * the details above, so checkout never fails because of Stripe.
 */
export const bankTransferPaymentHandler = new PaymentMethodHandler({
    code: BANK_TRANSFER_HANDLER_CODE,
    description: [{ languageCode: LanguageCode.en, value: 'Bank transfer (Checkout Guard)' }],
    args: {
        accountName: {
            type: 'string',
            label: [{ languageCode: LanguageCode.en, value: 'Account name' }],
            description: [{ languageCode: LanguageCode.en, value: 'Beneficiary name shown to the customer.' }],
            defaultValue: '',
        },
        accountNumber: {
            type: 'string',
            label: [{ languageCode: LanguageCode.en, value: 'Account number' }],
            defaultValue: '',
        },
        sortCode: {
            type: 'string',
            label: [{ languageCode: LanguageCode.en, value: 'Sort code' }],
            description: [{ languageCode: LanguageCode.en, value: 'UK domestic transfers (leave blank if not applicable).' }],
            defaultValue: '',
        },
        iban: {
            type: 'string',
            label: [{ languageCode: LanguageCode.en, value: 'IBAN' }],
            description: [{ languageCode: LanguageCode.en, value: 'International transfers (leave blank if not applicable).' }],
            defaultValue: '',
        },
        bic: {
            type: 'string',
            label: [{ languageCode: LanguageCode.en, value: 'BIC / SWIFT' }],
            defaultValue: '',
        },
        instructions: {
            type: 'string',
            label: [{ languageCode: LanguageCode.en, value: 'Instructions' }],
            description: [{
                languageCode: LanguageCode.en,
                value: 'Free text shown under the bank details, e.g. what to quote as the reference and when the order is fulfilled.',
            }],
            ui: { component: 'textarea-form-input' },
            defaultValue: 'Please quote your order number as the payment reference. Your order is reserved and will be fulfilled once we confirm receipt of funds.',
        },
        expiryDays: {
            type: 'int',
            label: [{ languageCode: LanguageCode.en, value: 'Pay within (days)' }],
            description: [{
                languageCode: LanguageCode.en,
                value: 'Days the customer has to pay. Shown as the pay-by date and used by the automatic expiry sweep.',
            }],
            defaultValue: DEFAULT_BANK_TRANSFER_EXPIRY_DAYS,
            ui: { component: 'number-form-input', min: 1, max: 90, step: 1 },
        },
    },

    init(injector: Injector) {
        connection = injector.get(TransactionalConnection);
    },

    createPayment: async (ctx, order, amount, args) => {
        const viaStripe = await stripeBankTransferPayment(ctx, order, amount, args);
        if (viaStripe) return viaStripe;
        const details = buildBankTransferPublicDetails({
            orderCode: order.code,
            amountMinor: amount,
            currency: order.currencyCode,
            args,
        });
        return {
            amount,
            // Authorized, not Settled: the order is placed and held pending funds.
            state: 'Authorized' as const,
            transactionId: order.code,
            metadata: { public: details },
        };
    },

    // Admin "mark received" / "Settle payment" — success moves the order to
    // PaymentSettled. A Stripe-backed transfer settled by hand also has its
    // PaymentIntent retired (Stripe's own settlements are recognised).
    settlePayment: async (ctx, order, payment) => {
        const paymentIntentId = stripePaymentIntentIdOf(payment.metadata);
        if (!paymentIntentId) return { success: true };
        return settleStripeTransfer(ctx, order, payment, paymentIntentId);
    },

    // Unpaid transfer (admin cancel or the expiry sweep). A Stripe-backed
    // transfer also has its PaymentIntent cancelled, best effort.
    cancelPayment: async (ctx, order, payment) => {
        const paymentIntentId = stripePaymentIntentIdOf(payment.metadata);
        if (!paymentIntentId) return { success: true };
        return releaseStripeTransfer(ctx, order, payment, paymentIntentId);
    },
});

/** Logged once per channel and method, so the operator can see which Stripe account a channel's transfers use. */
const methodLogged = new Set<string>();

/** The Stripe key for bank transfers on a channel: its own Stripe method first (see `preferOwnMethod`). */
async function stripeKeyFor(channelId: ID): Promise<string | undefined> {
    if (!connection) return undefined;
    const method = await getStripeMethodForChannelId(connection, channelId, { preferOwnMethod: true }).catch(() => undefined);
    if (method && !methodLogged.has(`${channelId}:${method.code}`)) {
        methodLogged.add(`${channelId}:${method.code}`);
        Logger.info(`Stripe bank transfers on channel ${channelId} use the Stripe payment method "${method.code}"`, loggerCtx);
    }
    return method?.apiKey;
}

/**
 * Two submits of one checkout (a double click) run side by side, and Stripe
 * answers the second with the first one's PaymentIntent (same idempotency
 * key). Lock the order row for the rest of this transaction, then re-read
 * it: if another request has moved the order on meanwhile, this one is the
 * duplicate. Without lock support the check is skipped.
 */
async function isConcurrentDuplicate(ctx: RequestContext, order: Order): Promise<boolean> {
    if (!connection || !order?.state) return false;
    try {
        const latest = await connection.getRepository(ctx, Order).createQueryBuilder('o')
            .setLock('pessimistic_write').where('o.id = :id', { id: order.id }).getOne();
        return !!latest && !!latest.state && latest.state !== order.state;
    } catch (e: any) {
        Logger.verbose(`Could not lock order ${order.code} for its bank transfer (${e?.message || e}); continuing`, loggerCtx);
        return false;
    }
}

/** The active user, when the checkout is signed in as the order's (registered) customer; else null. */
async function signedInOwner(ctx: RequestContext, order: Order): Promise<ID | null> {
    const userId = ctx.activeUserId;
    const customerId = order.customer?.id;
    if (userId === undefined || userId === null || customerId === undefined || customerId === null) return null;
    const known = order.customer?.user?.id;
    if (known !== undefined && known !== null) return String(known) === String(userId) ? userId : null;
    if (!connection) return null;
    try {
        const customer = await connection.getRepository(ctx, Customer).findOne({ where: { id: customerId }, relations: ['user'] });
        return customer && !customer.deletedAt && customer.user && String(customer.user.id) === String(userId) ? userId : null;
    } catch {
        return null;
    }
}

/**
 * The Stripe path of `createPayment`: null when the mode is off or the
 * currency is not a Stripe one (static details, exactly as before), and also
 * null after any Stripe failure, which is logged and alerted.
 */
async function stripeBankTransferPayment(
    ctx: RequestContext, order: Order, amount: number, args: BankDetailsArgs,
): Promise<CreatePaymentResult | CreatePaymentErrorResult | null> {
    const settings = getBankTransferRuntime().stripe;
    if (!settings) return null;
    const currency = String(order.currencyCode || '').toUpperCase();
    if (!settings.currencies.includes(currency)) return null;
    if (await isConcurrentDuplicate(ctx, order)) {
        Logger.warn(`Second bank-transfer payment request for order ${order.code} refused: another request has already placed the order`, loggerCtx);
        return {
            amount,
            state: 'Error' as const,
            errorMessage: 'bank-transfer: this order has just been placed by another request (submitted twice?); reload the order to see its payment details',
            metadata: {},
        };
    }
    let apiKey: string | undefined;
    try {
        apiKey = await stripeKeyFor(ctx.channelId);
        if (!apiKey) throw new StripeBankTransferError('no_key', `no Stripe secret key on channel ${ctx.channel?.code ?? ctx.channelId}`);
        const customer = order.customer;
        if (!customer?.emailAddress) throw new StripeBankTransferError('no_customer', 'the order has no customer e-mail address');
        const ownerUserId = await signedInOwner(ctx, order);
        const out = await createStripeBankTransfer(apiKey, {
            orderCode: order.code,
            orderId: order.id,
            channelId: ctx.channelId,
            amountMinor: amount,
            currency,
            customer: { id: customer.id, emailAddress: customer.emailAddress, firstName: customer.firstName, lastName: customer.lastName, ownerUserId },
            expiryDays: args.expiryDays,
            settings,
        });
        const metadata: Record<string, unknown> = {
            public: out.details,
            // Admin-only: the webhook, the sweep and the cancel find the intent through these.
            paymentIntentId: out.paymentIntentId,
            stripeCustomerId: out.customerId,
            stripeChannelId: String(ctx.channelId),
            stripeStatus: out.status,
        };
        if (out.kind === 'paid') {
            Logger.info(`Bank transfer for order ${order.code} was paid in full from the signed-in customer's Stripe cash balance (${out.paymentIntentId})`, loggerCtx);
            return {
                amount, state: 'Settled' as const, transactionId: order.code,
                metadata: { ...metadata, settledBy: 'stripe', stripeSettledAt: new Date().toISOString() },
            };
        }
        Logger.info(
            `Bank transfer for order ${order.code} goes through Stripe (${out.paymentIntentId}, reference ${out.details.reference}, `
            + `${out.reusedCustomer ? 'returning' : 'new'} Stripe customer)`,
            loggerCtx,
        );
        return { amount, state: 'Authorized' as const, transactionId: order.code, metadata };
    } catch (e) {
        const reason = describeStripeFailure(e);
        Logger.warn(`Stripe bank transfer for order ${order.code} failed (${reason}); the payment method's own bank details were shown instead`, loggerCtx);
        const bt = e instanceof StripeBankTransferError ? e : null;
        const balanceNote = bt?.reason === 'balance_applied'
            ? (bt.intentStatus === 'succeeded'
                ? ` Stripe has taken that balance for PaymentIntent ${bt.paymentIntentId}, which cannot be cancelled: refund it from the Stripe dashboard.`
                : ` PaymentIntent ${bt.paymentIntentId} is being cancelled, which returns the balance to the customer.`)
            : '';
        notifyBankTransferOps({
            event: 'bank.stripe_fallback',
            text: `Checkout Guard: Stripe could not set up the bank transfer for order ${order.code} (${formatMinor(amount, currency)}): ${reason}. `
                + `The customer was shown your own bank details instead, so this order has to be marked received by hand.${balanceNote}`,
            orderCode: order.code,
            paymentIntentId: bt?.paymentIntentId,
            amountMinor: amount,
            currency,
            channelId: ctx.channelId,
            provider: 'stripe',
        });
        if (bt?.stray && apiKey) scheduleStrayIntentRecovery(apiKey, bt.stray, ctx.channelId);
        return null;
    }
}

/** Another live payment on the same order that carries the same PaymentIntent (Settled first), or null. */
async function twinPayment(orderId: ID, paymentId: ID, paymentIntentId: string): Promise<{ id: ID; state: string } | null> {
    if (!connection) return null;
    try {
        const rows: Array<{ id: ID; state: string; metadata: unknown }> = await adapterFor(connection.rawConnection).query(
            `SELECT id, state, metadata FROM payment WHERE \`orderId\` = ? AND id <> ?`, [orderId, paymentId],
        );
        const twins = (rows ?? []).filter(r => stripePaymentIntentIdOf(r.metadata) === paymentIntentId && ['Authorized', 'Settled'].includes(String(r.state)));
        return twins.find(r => r.state === 'Settled') ?? twins[0] ?? null;
    } catch {
        return null;
    }
}

/**
 * `settlePayment` for a Stripe-backed transfer. Stripe's own settlements (the
 * webhook and the sweep note the intent as succeeded first) are marked
 * `settledBy: 'stripe'`. Anything else is a settlement by hand: if Stripe has
 * the money after all it counts as Stripe's; otherwise the PaymentIntent is
 * cancelled, so a later transfer to the customer's virtual account cannot be
 * matched to this (already paid) order without anyone noticing.
 */
async function settleStripeTransfer(
    ctx: RequestContext, order: Order, payment: Payment, paymentIntentId: string,
): Promise<SettlePaymentResult | SettlePaymentErrorResult> {
    const twin = await twinPayment(order.id, payment.id, paymentIntentId);
    if (twin?.state === 'Settled') {
        return {
            success: false,
            state: 'Authorized',
            errorMessage: `bank-transfer: payment ${twin.id} has already been settled for this Stripe transfer (${paymentIntentId}); cancel this duplicate payment instead`,
        };
    }
    const now = new Date().toISOString();
    const byStripe = { success: true as const, metadata: { stripeStatus: 'succeeded', settledBy: 'stripe', stripeSettledAt: now } };
    if (isStripeTransferKnownSucceeded(paymentIntentId)) return byStripe;
    const channelId = stripeChannelIdOf(payment.metadata) ?? ctx.channelId;
    const apiKey = await stripeKeyFor(channelId);
    const outcome = apiKey
        ? await cancelStripeBankTransfer(apiKey, paymentIntentId)
        : { kind: 'failed' as const, message: `no Stripe secret key on channel ${channelId}`, received: null };
    if (outcome.kind === 'succeeded') {
        Logger.info(`Bank transfer for order ${order.code} was settled by hand, and Stripe has received it too (${paymentIntentId})`, loggerCtx);
        return byStripe;
    }
    const cur = order.currencyCode;
    if (outcome.kind === 'failed') {
        Logger.warn(`Bank transfer for order ${order.code} settled by hand, but its Stripe PaymentIntent ${paymentIntentId} could not be cancelled (${outcome.message})`, loggerCtx);
        notifyBankTransferOps({
            event: 'bank.stripe_cancel_failed',
            text: `Checkout Guard: the bank transfer for order ${order.code} was marked received by hand, but its Stripe PaymentIntent ${paymentIntentId} could not be cancelled (${outcome.message}). `
                + 'Cancel it in the Stripe dashboard: while it is open, a transfer the customer sends to their Stripe account is matched to this already settled order.',
            orderCode: order.code, paymentIntentId, amountMinor: payment.amount, currency: cur, channelId, provider: 'stripe',
        });
        return { success: true, metadata: { settledBy: 'hand', stripeSettledByHandAt: now, stripeCancelError: outcome.message } };
    }
    const received = fromStripeMinorUnits(outcome.received, cur);
    if (received > 0) {
        notifyBankTransferOps({
            event: 'bank.stripe_partially_funded',
            text: `Checkout Guard: the bank transfer for order ${order.code} was marked received by hand while ${formatMinor(received, cur)} of ${formatMinor(payment.amount, cur)} had already arrived through Stripe (${paymentIntentId}). `
                + 'The PaymentIntent was cancelled, so that part payment is now in the customer\'s Stripe cash balance: refund it from the Stripe dashboard (Customers → the customer → Cash balance) if the order is paid in full elsewhere.',
            orderCode: order.code, paymentIntentId, amountMinor: received, currency: cur, channelId, provider: 'stripe',
        });
    }
    Logger.info(`Bank transfer for order ${order.code} settled by hand; Stripe PaymentIntent ${paymentIntentId} cancelled${outcome.already ? ' (already cancelled at Stripe)' : ''}`, loggerCtx);
    return { success: true, metadata: { settledBy: 'hand', stripeSettledByHandAt: now, stripeStatus: 'canceled', stripeCancelledAt: now } };
}

/**
 * `cancelPayment` for a Stripe-backed transfer. Only a transfer Stripe says
 * is paid refuses to cancel. A part payment that the cancel returns to the
 * customer's cash balance is alerted, on every cancel path (expiry, Checkout
 * Guard's cancel, Vendure's "Cancel payment", a cancelled order).
 */
async function releaseStripeTransfer(
    ctx: RequestContext, order: Order, payment: Payment, paymentIntentId: string,
): Promise<CancelPaymentResult | CancelPaymentErrorResult> {
    const twin = await twinPayment(order.id, payment.id, paymentIntentId);
    if (twin) {
        // A duplicate of another live payment: the intent belongs to that one.
        Logger.info(`Cancelling payment ${payment.id} of order ${order.code}, a duplicate of payment ${twin.id} for ${paymentIntentId}; the PaymentIntent is left as it is`, loggerCtx);
        return { success: true, metadata: { stripeDuplicateOf: String(twin.id) } };
    }
    const channelId = stripeChannelIdOf(payment.metadata) ?? ctx.channelId;
    const apiKey = await stripeKeyFor(channelId);
    const outcome = apiKey
        ? await cancelStripeBankTransfer(apiKey, paymentIntentId)
        : { kind: 'failed' as const, message: `no Stripe secret key on channel ${channelId}`, received: null };
    const cur = order.currencyCode;
    if (outcome.kind === 'succeeded') {
        Logger.warn(`Not cancelling the bank transfer for order ${order.code}: Stripe has already received the money (${paymentIntentId})`, loggerCtx);
        return {
            success: false,
            state: 'Authorized',
            errorMessage: 'bank-transfer: the customer has already paid this transfer through Stripe; settle the payment instead of cancelling it',
        };
    }
    if (outcome.kind === 'failed') {
        const part = outcome.received ? fromStripeMinorUnits(outcome.received, cur) : 0;
        Logger.warn(`Could not cancel Stripe PaymentIntent ${paymentIntentId} for order ${order.code} (${outcome.message}); cancel it in the Stripe dashboard`, loggerCtx);
        notifyBankTransferOps({
            event: 'bank.stripe_cancel_failed',
            text: `Checkout Guard: the bank transfer for order ${order.code} was cancelled, but its Stripe PaymentIntent ${paymentIntentId} could not be (${outcome.message}). `
                + 'Cancel it in the Stripe dashboard: until then, a transfer the customer sends with its reference still completes it.'
                + (part > 0 ? ` ${formatMinor(part, cur)} of ${formatMinor(payment.amount, cur)} had already arrived; cancelling it returns that to the customer's cash balance, to be refunded.` : ''),
            orderCode: order.code,
            paymentIntentId,
            amountMinor: payment.amount,
            currency: cur,
            channelId,
            provider: 'stripe',
        });
        return { success: true, metadata: { stripeCancelError: outcome.message } };
    }
    const received = fromStripeMinorUnits(outcome.received, cur);
    if (received > 0) {
        notifyBankTransferOps({
            event: 'bank.stripe_partially_funded',
            text: `Checkout Guard: the bank transfer for order ${order.code} was cancelled with ${formatMinor(received, cur)} of ${formatMinor(payment.amount, cur)} already paid through Stripe (${paymentIntentId}). `
                + 'Cancelling the PaymentIntent put that money back in the customer\'s Stripe cash balance: refund it from the Stripe dashboard (Customers → the customer → Cash balance).',
            orderCode: order.code, paymentIntentId, amountMinor: received, currency: cur, channelId, provider: 'stripe',
        });
    }
    Logger.info(`Cancelled Stripe PaymentIntent ${paymentIntentId} for order ${order.code}${outcome.already ? ' (already cancelled at Stripe)' : ''}`, loggerCtx);
    return { success: true, metadata: { stripeStatus: 'canceled', stripeCancelledAt: new Date().toISOString() } };
}

/** Recovery passes after a create whose answer was lost: Stripe needs a moment before a just-created intent is listed. */
const STRAY_RECOVERY_DELAYS_MS = [30_000, 5 * 60_000];

/** True when a payment of the order carries the intent (a later checkout of the same order used it). */
async function intentInUse(orderCode: string, paymentIntentId: string): Promise<boolean> {
    if (!connection) return true;
    const rows: Array<{ metadata: unknown }> = await adapterFor(connection.rawConnection).query(
        `SELECT p.metadata AS metadata FROM payment p JOIN \`order\` o ON o.id = p.\`orderId\` WHERE o.code = ?`, [orderCode],
    );
    return (rows ?? []).some(r => stripePaymentIntentIdOf(r.metadata) === paymentIntentId);
}

/**
 * A PaymentIntent create that timed out or failed in transit may still have
 * happened at Stripe, leaving an intent that no payment knows. Nobody was
 * shown its details, but Stripe would match the customer's later transfers
 * (or apply their cash balance) to it. Out of the checkout's time budget, look
 * for that order's intents on the customer and cancel any that no payment
 * carries; one already paid is alerted. Fire and forget.
 */
export function scheduleStrayIntentRecovery(apiKey: string, stray: StrayBankTransferIntent, channelId: ID, attempt = 0): void {
    const delay = STRAY_RECOVERY_DELAYS_MS[attempt];
    if (delay === undefined) return;
    const timer = setTimeout(() => {
        void recoverStrayIntent(apiKey, stray, channelId, attempt).catch(e =>
            Logger.warn(`Stray PaymentIntent recovery for order ${stray.orderCode} failed: ${e?.message || e}`, loggerCtx));
    }, delay);
    (timer as any)?.unref?.();
}

async function recoverStrayIntent(apiKey: string, stray: StrayBankTransferIntent, channelId: ID, attempt: number): Promise<void> {
    const last = attempt + 1 >= STRAY_RECOVERY_DELAYS_MS.length;
    let intents: Array<{ id: string; status: string }>;
    try {
        intents = stray.paymentIntentId
            ? [{ id: stray.paymentIntentId, status: 'unknown' }]
            : await findStrayBankTransferIntents(apiKey, stray);
    } catch (e) {
        if (!last) return scheduleStrayIntentRecovery(apiKey, stray, channelId, attempt + 1);
        notifyBankTransferOps({
            event: 'bank.stripe_cancel_failed',
            text: `Checkout Guard: Stripe did not answer when the bank transfer for order ${stray.orderCode} was set up, and the PaymentIntent it may have created could not be looked up (${describeStripeFailure(e)}). `
                + `In the Stripe dashboard, cancel any incomplete payment of customer ${stray.customerId} whose metadata has cg_order_code ${stray.orderCode}.`,
            orderCode: stray.orderCode, channelId, provider: 'stripe',
        });
        return;
    }
    if (!intents.length) {
        if (!last) scheduleStrayIntentRecovery(apiKey, stray, channelId, attempt + 1);
        return;
    }
    for (const pi of intents) {
        if (pi.status === 'canceled' || await intentInUse(stray.orderCode, pi.id)) continue;
        const out = await cancelStripeBankTransfer(apiKey, pi.id);
        if (out.kind === 'canceled') {
            Logger.info(`Cancelled stray Stripe PaymentIntent ${pi.id} for order ${stray.orderCode}${out.already ? ' (already cancelled)' : ''}`, loggerCtx);
        } else if (out.kind === 'succeeded') {
            notifyBankTransferOps({
                event: 'bank.stripe_unsettled',
                text: `Checkout Guard: Stripe PaymentIntent ${pi.id} for order ${stray.orderCode} was paid (from the customer's cash balance) although checkout never received it and showed your own bank details instead. `
                    + 'Refund it from the Stripe dashboard, or settle the order by hand if that payment covers it.',
                orderCode: stray.orderCode, paymentIntentId: pi.id, channelId, provider: 'stripe',
            });
        } else {
            notifyBankTransferOps({
                event: 'bank.stripe_cancel_failed',
                text: `Checkout Guard: stray Stripe PaymentIntent ${pi.id} for order ${stray.orderCode} (created while checkout was not waiting any more) could not be cancelled (${out.message}). Cancel it in the Stripe dashboard.`,
                orderCode: stray.orderCode, paymentIntentId: pi.id, channelId, provider: 'stripe',
            });
        }
    }
}

/** Test hook: forget which Stripe methods were logged. */
export function _resetBankTransferHandlerLog(): void { methodLogged.clear(); }
