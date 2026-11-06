import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Channel, Logger, OrderStateTransitionEvent, Payment, PaymentMethod } from '@vendure/core';

import {
    FakeConnection, errorResult, fakeOrderService, fakeRequestContextService, flushAsync, installFakeStripe, stripeBankTransferIntent,
} from '../__tests__/fakes';
import { configureStripeHold } from '../stripe-hold/runtime';
import { StripeHoldController } from '../stripe-hold/stripe-hold.controller';
import { StripeHoldService } from '../stripe-hold/stripe-hold.service';
import { resetMethodsCache } from '../stripe-hold/stripe-key';
import { buildStripeSignatureHeader } from '../stripe-hold/stripe-signature';
import { setBankTransferRuntime } from './bank-transfer-runtime';
import { BankTransferExpiredEvent } from './bank-transfer.events';
import { _resetBankTransferHandlerLog, bankTransferPaymentHandler } from './bank-transfer.handler';
import { BankTransferService } from './bank-transfer.service';
import { _resetStripeBankTransferWarnings, normaliseStripeBankTransferOptions } from './stripe-bank-transfer';

/**
 * Settlement of Stripe bank transfers: the webhook path (through the real
 * webhook controller and signature check), the ten-minute sweep fallback,
 * the expiry sweep's Stripe check and PaymentIntent cancel, cancelled
 * orders and cash balance alerts. In-memory database fakes, a fake Stripe on
 * the global fetch; nothing leaves the process.
 */

const channels = [
    { id: 1, token: 'tok-default', code: '__default_channel__' },
    { id: 2, token: 'tok-ld', code: 'licensedock' },
];
const stripeMethod = { id: 1, code: 'stripe', enabled: true, handler: { code: 'stripe', args: [{ name: 'apiKey', value: 'sk_test_bt' }] }, channels: [{ id: 2, code: 'licensedock' }] };
const days = (n: number) => new Date(Date.now() - n * 86_400_000);
const MIN = 60_000;

let sqlRoutes: Array<{ re: RegExp; rows: (params: any[]) => any[] }>;
let conn: FakeConnection;
let orders: ReturnType<typeof fakeOrderService>;
let eventBus: { publish: ReturnType<typeof vi.fn> };
let svc: BankTransferService;
let notify: ReturnType<typeof vi.fn>;
let stripe: ReturnType<typeof installFakeStripe>;
let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let premium = true;

function stripeMetadata(over: Record<string, any> = {}) {
    return {
        public: { method: 'bank-transfer', provider: 'stripe', reference: 'RF7K2M9Q4XWZ', payBy: days(-6).toISOString(), currency: 'GBP', accountName: 'HULO GLOBAL LIMITED', amountMinor: 12999 },
        paymentIntentId: 'pi_bt123', stripeCustomerId: 'cus_123', stripeChannelId: '2', stripeStatus: 'requires_action', ...over,
    };
}
const ORDER = { id: 10, code: 'ORD1', state: 'PaymentAuthorized', currencyCode: 'GBP', channels: [channels[0], channels[1]] };
function stripePayment(over: Record<string, any> = {}): any {
    return { id: 41, method: 'bank-transfer', state: 'Authorized', amount: 12999, createdAt: days(1), metadata: stripeMetadata(), order: { ...ORDER }, ...over };
}
/** What `payment_intent.*` events carry: the intent, here already paid. */
function event(type: string, over: Record<string, any> = {}) {
    return { id: 'evt_1', type, data: { object: stripeBankTransferIntent({ status: 'succeeded', amount_received: 12999, next_action: null, created: Math.floor(days(1).getTime() / 1000), ...over }) } };
}
/** The order's bank-transfer payments, as `findStripeBackedPayments` reads them. */
function routeOrderPayments(rows: () => any[]) {
    sqlRoutes.push({ re: /LEFT JOIN payment p ON p\.`orderId` = o\.id/, rows });
}
function routeTwins(rows: () => any[]) {
    sqlRoutes.push({ re: /SELECT id, state, metadata FROM payment WHERE `orderId` = \? AND id <> \?/, rows });
}
/** `OrderService.settlePayment` / `cancelPayment` calling the handler, as Vendure does, and applying the result. */
function wireHandlerThroughVendure() {
    orders.settlePayment.mockImplementation(async (ctx: any, paymentId: any) => {
        conn.log.push(`settle:${paymentId}`);
        const p = conn.repo(Payment).rows.find(r => String(r.id) === String(paymentId))!;
        const res: any = await bankTransferPaymentHandler.settlePayment!(ctx, p.order, p as any, [], { code: 'bank-transfer' } as any);
        if (!res.success) return errorResult(res.errorMessage, 'SETTLE_PAYMENT_ERROR', { paymentErrorMessage: res.errorMessage });
        p.metadata = { ...p.metadata, ...res.metadata };
        p.state = 'Settled';
        return p;
    });
    orders.cancelPayment.mockImplementation(async (ctx: any, paymentId: any) => {
        conn.log.push(`cancelPayment:${paymentId}`);
        const p = conn.repo(Payment).rows.find(r => String(r.id) === String(paymentId))!;
        const res: any = await bankTransferPaymentHandler.cancelPayment!(ctx, p.order, p as any, [], { code: 'bank-transfer' } as any);
        return res.success ? { ...p, state: 'Cancelled' } : errorResult(res.errorMessage, 'CANCEL_PAYMENT_ERROR', { paymentErrorMessage: res.errorMessage });
    });
}

beforeEach(() => {
    _resetStripeBankTransferWarnings();
    _resetBankTransferHandlerLog();
    premium = true;
    sqlRoutes = [
        { re: /SELECT code, handler FROM payment_method/, rows: () => [{ code: 'bank-transfer', handler: JSON.stringify({ code: 'bank-transfer', args: [] }) }, { code: 'stripe', handler: JSON.stringify({ code: 'stripe' }) }] },
    ];
    conn = new FakeConnection({ query: (sql: string, params: any[] = []) => { const hit = sqlRoutes.find(r => r.re.test(sql.replace(/\s+/g, ' '))); return hit ? hit.rows(params) : []; } });
    conn.repo(PaymentMethod).rows = [stripeMethod];
    conn.repo(Channel).rows = channels;
    resetMethodsCache(conn as any);
    orders = fakeOrderService(conn);
    orders.findOne.mockImplementation(async (_ctx: any, id: any) => ({ id, state: 'PaymentSettled', code: 'ORD1' }));
    eventBus = { publish: vi.fn(async () => undefined) };
    notify = vi.fn(async () => undefined);
    setBankTransferRuntime({
        expiryDays: 7, reminderAfterDays: 3, hasPremiumAccess: () => premium,
        stripe: normaliseStripeBankTransferOptions({ enabled: true }), notifyOps: notify,
    });
    svc = new BankTransferService(conn as any, orders as any, fakeRequestContextService(channels) as any, eventBus as any);
    bankTransferPaymentHandler.init({ get: () => conn } as any);
    info = vi.spyOn(Logger, 'info').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger, 'verbose').mockImplementation(() => undefined);
    stripe = installFakeStripe(call => {
        if (call.method === 'GET' && call.path === '/v1/payment_intents/pi_bt123') return { body: stripeBankTransferIntent() };
        if (call.method === 'POST' && call.path === '/v1/payment_intents/pi_bt123/cancel') return { body: { id: 'pi_bt123', status: 'canceled' } };
        return { status: 404, body: { error: { message: 'no route' } } };
    });
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('webhook: payment_intent.succeeded', () => {
    it('settles the order\'s Authorized bank-transfer payment in the order\'s channel and tracks it', async () => {
        routeOrderPayments(() => [{ orderId: 10, paymentId: 41, metadata: JSON.stringify(stripeMetadata()) }]);
        conn.repo(Payment).rows = [stripePayment()];
        const r = await svc.handleStripeEvent(event('payment_intent.succeeded'));
        expect(r).toEqual({ status: 200, message: 'Bank transfer pi_bt123 settled for order ORD1' });
        expect(conn.ran(/LEFT JOIN payment p ON/)[0].params).toEqual(['bank-transfer', 'ORD1']);
        // Vendure's settle runs under the row lock, in an admin context for the order's own channel.
        expect(conn.log).toEqual(['tx:start', 'settle:41', 'tx:end']);
        expect(orders.settlePayment.mock.calls[0][0]).toMatchObject({ apiType: 'admin', channelId: 2 });
        // The tracking row is marked settled exactly as "mark received" does.
        expect(conn.ran(/INSERT IGNORE INTO checkout_guard_bank_transfer/)[0].params.slice(0, 6)).toEqual([41, 10, 'ORD1', 2, 12999, 'GBP']);
        expect(conn.ran(/SET settledAt = NOW\(\) WHERE paymentId = \?/)[0].params).toEqual([41]);
        // The event is signed: no Stripe round trip, no alert.
        expect(stripe.calls).toHaveLength(0);
        expect(notify).not.toHaveBeenCalled();
    });

    it('marks the settlement as Stripe\'s, so the handler does not treat it as one by hand', async () => {
        wireHandlerThroughVendure();
        routeOrderPayments(() => [{ orderId: 10, paymentId: 41, metadata: stripeMetadata() }]);
        conn.repo(Payment).rows = [stripePayment()];
        await svc.handleStripeEvent(event('payment_intent.succeeded'));
        expect(conn.repo(Payment).rows[0]).toMatchObject({ state: 'Settled', metadata: { stripeStatus: 'succeeded', settledBy: 'stripe' } });
        expect(stripe.calls).toHaveLength(0); // no look-up, no cancel
    });

    it('is idempotent: a redelivery, or a delivery racing the sweep, settles nothing twice', async () => {
        routeOrderPayments(() => [{ orderId: 10, paymentId: 41, metadata: stripeMetadata() }]);
        conn.repo(Payment).rows = [stripePayment({ state: 'Settled', metadata: stripeMetadata({ stripeStatus: 'succeeded', settledBy: 'stripe' }) })];
        expect(await svc.handleStripeEvent(event('payment_intent.succeeded'))).toEqual({ status: 200, message: 'Bank transfer pi_bt123 already settled' });

        conn.repo(Payment).rows = [stripePayment()];
        conn.repo(Payment).lockOverride = () => stripePayment({ state: 'Settled' });
        expect(await svc.handleStripeEvent(event('payment_intent.succeeded'))).toEqual({ status: 200, message: 'Bank transfer pi_bt123 already settled' });
        expect(orders.settlePayment).not.toHaveBeenCalled();
        expect(conn.ran(/SET settledAt/)).toHaveLength(0);
        expect(notify).not.toHaveBeenCalled();
    });

    it('raises a possible double payment when Stripe receives a transfer already marked received by hand', async () => {
        routeOrderPayments(() => [{ orderId: 10, paymentId: 41, metadata: stripeMetadata() }]);
        conn.repo(Payment).rows = [stripePayment({ state: 'Settled', metadata: stripeMetadata({ settledBy: 'hand', stripeCancelError: 'boom' }), order: { ...ORDER, state: 'PaymentSettled' } })];
        expect(await svc.handleStripeEvent(event('payment_intent.succeeded'))).toEqual({ status: 200, message: 'Bank transfer pi_bt123 already settled' });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({ event: 'bank.stripe_unsettled', orderCode: 'ORD1', paymentIntentId: 'pi_bt123' });
        expect(notify.mock.calls[0][0].text).toMatch(/already been marked received by hand.*paid twice/);
    });

    it('settles one of two payments that carry the same intent, never both (webhook, then sweep)', async () => {
        // A double submit that slipped past the order lock: payments 41 and 43 carry pi_bt123.
        routeOrderPayments(() => [{ orderId: 10, paymentId: 41, metadata: stripeMetadata() }, { orderId: 10, paymentId: 43, metadata: stripeMetadata() }]);
        conn.repo(Payment).rows = [stripePayment(), stripePayment({ id: 43 })];
        expect((await svc.handleStripeEvent(event('payment_intent.succeeded'))).message).toBe('Bank transfer pi_bt123 settled for order ORD1');
        expect(conn.log.filter(l => l.startsWith('settle:'))).toEqual(['settle:41']);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'bank.stripe_unsettled', orderCode: 'ORD1', paymentIntentId: 'pi_bt123' }));
        expect(notify.mock.calls[0][0].text).toMatch(/Payment 41 is the one settled with it; cancel payment 43/);

        // What Vendure leaves behind; the sweep and a redelivery see it.
        conn.repo(Payment).rows = [
            stripePayment({ state: 'Settled', metadata: stripeMetadata({ settledBy: 'stripe' }), order: { ...ORDER, state: 'PaymentSettled' } }),
            stripePayment({ id: 43, order: { ...ORDER, state: 'PaymentSettled' } }),
        ];
        sqlRoutes.push({ re: /p\.metadata LIKE \?/, rows: () => [{ paymentId: 43, metadata: stripeMetadata() }] });
        stripe.respond(() => ({ body: stripeBankTransferIntent({ status: 'succeeded', amount_received: 12999, next_action: null }) }));
        expect(await svc.syncStripe(new Date())).toEqual({ checked: 0, settled: 0, awaiting: 0, skipped: null });
        expect((await svc.handleStripeEvent(event('payment_intent.succeeded'))).message).toBe('Bank transfer pi_bt123 already settled');
        expect(conn.log.filter(l => l.startsWith('settle:'))).toEqual(['settle:41']);
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('does not settle an order that is already paid some other way', async () => {
        routeOrderPayments(() => [{ orderId: 10, paymentId: 41, metadata: stripeMetadata() }]);
        conn.repo(Payment).rows = [stripePayment({ order: { ...ORDER, state: 'PaymentSettled' } })];
        expect((await svc.handleStripeEvent(event('payment_intent.succeeded'))).message).toMatch(/the order is already paid \(PaymentSettled\), so nothing was settled/);
        expect(orders.settlePayment).not.toHaveBeenCalled();
        expect(notify.mock.calls[0][0].text).toMatch(/paid twice/);
    });

    it('does not settle when Stripe received less than the payment amount', async () => {
        routeOrderPayments(() => [{ orderId: 10, paymentId: 41, metadata: stripeMetadata() }]);
        conn.repo(Payment).rows = [stripePayment()];
        const r = await svc.handleStripeEvent(event('payment_intent.succeeded', { amount: 10000, amount_received: 10000 }));
        expect(r.message).toMatch(/Stripe received only £100\.00 of the payment's £129\.99, so nothing was settled/);
        expect(orders.settlePayment).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'bank.stripe_unsettled' }));
    });

    it('ignores intents it did not create (holds, card payments, other objects) without touching the database', async () => {
        const hold = { type: 'payment_intent.succeeded', data: { object: { id: 'pi_hold1', status: 'succeeded', capture_method: 'manual', metadata: { channelToken: 'tok-ld', orderCode: 'ORD1', orderId: '10' } } } };
        expect(await svc.handleStripeEvent(hold)).toEqual({ status: 200, message: 'Not a Checkout Guard bank transfer, ignored' });
        expect(await svc.handleStripeEvent({ type: 'charge.succeeded', data: { object: { id: 'ch_1', metadata: { cg_bank_transfer: '1', cg_order_code: 'ORD1', cg_channel_id: '2' } } } }))
            .toEqual({ status: 200, message: 'Not a Checkout Guard bank transfer, ignored' });
        expect(conn.queries).toHaveLength(0);
        expect(orders.settlePayment).not.toHaveBeenCalled();
    });

    it('asks Stripe to retry while a just-created intent has no payment yet, then alerts once', async () => {
        routeOrderPayments(() => [{ orderId: 10, paymentId: 41, metadata: stripeMetadata({ paymentIntentId: 'pi_other9' }) }, { orderId: 10, paymentId: null, metadata: null }]);
        conn.repo(Payment).rows = [stripePayment()];
        // Paid from a balance at confirmation: the event can beat the checkout's commit.
        const young = event('payment_intent.succeeded', { created: Math.floor(Date.now() / 1000) - 30 });
        expect(await svc.handleStripeEvent(young)).toEqual({ status: 503, message: 'No payment carries pi_bt123 yet; retry' });
        expect(notify).not.toHaveBeenCalled();
        expect(await svc.handleStripeEvent(event('payment_intent.succeeded'))).toEqual({ status: 200, message: 'No bank-transfer payment for this PaymentIntent' });
        await svc.handleStripeEvent(event('payment_intent.succeeded'));
        expect(orders.settlePayment).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({ event: 'bank.stripe_unsettled', orderCode: 'ORD1', paymentIntentId: 'pi_bt123', amountMinor: 12999, currency: 'GBP' });
    });

    it('ignores an order that is not in this database (another install on the same Stripe account)', async () => {
        routeOrderPayments(() => []);
        expect(await svc.handleStripeEvent(event('payment_intent.succeeded'))).toEqual({ status: 200, message: 'Order not found, ignored' });
        expect(notify).not.toHaveBeenCalled();
    });

    it('leaves money for a cancelled transfer or order to a human', async () => {
        routeOrderPayments(() => [{ orderId: 10, paymentId: 41, metadata: stripeMetadata() }]);
        conn.repo(Payment).rows = [stripePayment({ state: 'Cancelled' })];
        const r = await svc.handleStripeEvent(event('payment_intent.succeeded'));
        expect(r.message).toMatch(/its payment is Cancelled, so nothing was settled/);
        conn.repo(Payment).rows = [stripePayment({ order: { ...ORDER, state: 'Cancelled' } })];
        expect((await svc.handleStripeEvent(event('payment_intent.succeeded'))).message).toMatch(/the order is cancelled, so nothing was settled/);
        expect(orders.settlePayment).not.toHaveBeenCalled();
        expect(notify.mock.calls[0][0]).toMatchObject({ event: 'bank.stripe_unsettled', paymentIntentId: 'pi_bt123' });
        expect(notify.mock.calls[0][0].text).toMatch(/Refund the customer from the Stripe dashboard/);
    });

    it('reports a settle that Vendure refuses', async () => {
        routeOrderPayments(() => [{ orderId: 10, paymentId: 41, metadata: stripeMetadata() }]);
        conn.repo(Payment).rows = [stripePayment()];
        orders.settlePayment.mockImplementation(async () => errorResult('cannot settle', 'SETTLE_PAYMENT_ERROR'));
        expect(await svc.handleStripeEvent(event('payment_intent.succeeded'))).toEqual({ status: 200, message: 'Settle failed: cannot settle' });
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'bank.stripe_unsettled' }));
        expect(conn.ran(/SET settledAt/)).toHaveLength(0);
    });
});

describe('webhook: partial funding and other events', () => {
    it('keeps a partly funded transfer open, logs amount_remaining and asks only for the rest from then on', async () => {
        const metadata = stripeMetadata();
        routeOrderPayments(() => [{ orderId: 10, paymentId: 41, metadata }]);
        conn.repo(Payment).rows = [stripePayment({ metadata })];
        const r = await svc.handleStripeEvent({ type: 'payment_intent.partially_funded', data: { object: stripeBankTransferIntent({ instructions: { amount_remaining: 5000 } }) } });
        expect(r).toEqual({ status: 200, message: 'Bank transfer pi_bt123 is partly funded; the payment stays open' });
        expect(orders.settlePayment).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledWith(expect.stringMatching(/order ORD1 is partly paid at Stripe \(pi_bt123\): £79\.99 received, amount_remaining £50\.00/), 'CheckoutGuard');
        const [update] = conn.ran(/UPDATE payment SET metadata = \? WHERE id = \? AND state = 'Authorized'/);
        expect(update.params[1]).toBe(41);
        expect(JSON.parse(update.params[0])).toEqual({ ...metadata, public: { ...metadata.public, amountMinor: 5000 } });
        // An older event arriving late never raises the amount again.
        await svc.handleStripeEvent({ type: 'payment_intent.partially_funded', data: { object: stripeBankTransferIntent({ instructions: { amount_remaining: 9000 } }) } });
        expect(conn.ran(/UPDATE payment SET metadata/)).toHaveLength(1);
    });

    it('acknowledges everything else', async () => {
        expect((await svc.handleStripeEvent({ type: 'payment_intent.requires_action', data: { object: stripeBankTransferIntent() } })).message).toBe('Event payment_intent.requires_action ignored');
        expect((await svc.handleStripeEvent({ type: 'payment_intent.canceled', data: { object: stripeBankTransferIntent({ status: 'canceled' }) } })).status).toBe(200);
        expect(orders.settlePayment).not.toHaveBeenCalled();
    });
});

describe('webhook: cash balance transactions', () => {
    const txn = (over: Record<string, any> = {}) => ({
        id: 'evt_c', type: 'customer_cash_balance_transaction.created',
        data: { object: { id: 'ccsbtxn_1', object: 'customer_cash_balance_transaction', type: 'funded', customer: 'cus_123', currency: 'gbp', net_amount: 5000, ending_balance: 5000, ...over } },
    });
    /** The customer's payments, newest first, as the lookup by `stripeCustomerId` returns them. */
    let customerPayments: any[];
    let balance: number;
    beforeEach(() => {
        customerPayments = [{ paymentState: 'Cancelled', metadata: JSON.stringify(stripeMetadata()), orderCode: 'ORD1' }];
        balance = 5000;
        sqlRoutes.push({
            re: /p\.metadata LIKE \? ORDER BY p\.id DESC LIMIT 50/,
            rows: (params: any[]) => params.at(-1) === '%"stripeCustomerId":"cus_123"%' ? customerPayments : [],
        });
        stripe.respond(call => call.path === '/v1/customers/cus_123/cash_balance' ? { body: { object: 'cash_balance', available: { gbp: balance } } } : { status: 404, body: {} });
    });

    it('alerts money that reached a customer with no open bank transfer, once per amount', async () => {
        expect(await svc.handleCashBalanceEvent(txn())).toEqual({ status: 200, message: 'Unapplied cash balance alerted' });
        await svc.handleCashBalanceEvent(txn({ id: 'ccsbtxn_2' }));
        expect(stripe.calls[0].headers.Authorization).toBe('Bearer sk_test_bt');
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({ event: 'bank.stripe_unsettled', orderCode: 'ORD1', amountMinor: 5000, currency: 'GBP', channelId: '2' });
        expect(notify.mock.calls[0][0].text).toMatch(/£50\.00 is in the Stripe cash balance of customer cus_123 .*sent after the order was cancelled or expired.*order ORD1, Cancelled.*Refund it/);
    });

    it('leaves money alone that Stripe is applying to an open bank transfer of the customer', async () => {
        customerPayments = [{ paymentState: 'Authorized', metadata: JSON.stringify(stripeMetadata()), orderCode: 'ORD1' }];
        expect((await svc.handleCashBalanceEvent(txn())).message).toBe('The customer has an open bank transfer; Stripe applies the money to it');
        expect(stripe.calls).toHaveLength(0);
        expect(notify).not.toHaveBeenCalled();
    });

    it('alerts what an overpayment leaves once it has paid the customer\'s last open transfer', async () => {
        customerPayments = [{ paymentState: 'Authorized', metadata: JSON.stringify(stripeMetadata()), orderCode: 'ORD1' }];
        balance = 1000;
        const applied = txn({ type: 'applied_to_payment', net_amount: -12999, ending_balance: 1000, applied_to_payment: { payment_intent: 'pi_bt123' } });
        expect((await svc.handleCashBalanceEvent(applied)).message).toBe('Unapplied cash balance alerted');
        expect(notify.mock.calls[0][0]).toMatchObject({ amountMinor: 1000 });
        expect(notify.mock.calls[0][0].text).toMatch(/probably an overpayment/);
    });

    it('leaves money a Checkout Guard cancel returned to that cancel\'s own alert', async () => {
        const unapplied = (pi: string) => txn({ type: 'unapplied_from_payment', unapplied_from_payment: { payment_intent: pi } });
        expect((await svc.handleCashBalanceEvent(unapplied('pi_bt123'))).message).toMatch(/alerted when it was cancelled/);
        expect(notify).not.toHaveBeenCalled();
        expect((await svc.handleCashBalanceEvent(unapplied('pi_elsewhere'))).message).toBe('Unapplied cash balance alerted');
        expect(notify.mock.calls[0][0].text).toMatch(/returned when PaymentIntent pi_elsewhere was cancelled/);
    });

    it('stays quiet when nothing is left in the balance', async () => {
        balance = 0;
        expect((await svc.handleCashBalanceEvent(txn())).message).toBe('Nothing left in the cash balance');
        expect((await svc.handleCashBalanceEvent(txn({ type: 'applied_to_payment', ending_balance: 0 }))).message).toBe('Cash balance fully applied');
        expect(notify).not.toHaveBeenCalled();
    });

    it('ignores customers it did not create, and other objects, without asking Stripe', async () => {
        expect((await svc.handleCashBalanceEvent(txn({ customer: 'cus_stranger' }))).message).toBe('Not a Checkout Guard customer, ignored');
        expect((await svc.handleCashBalanceEvent({ type: 'customer_cash_balance_transaction.created', data: { object: { id: 'x', object: 'charge' } } })).message).toMatch(/Not a cash balance/);
        expect((await svc.handleCashBalanceEvent(txn({ type: 'return_initiated' }))).message).toBe('Cash balance return_initiated ignored');
        expect(stripe.calls).toHaveLength(0);
        expect(notify).not.toHaveBeenCalled();
    });
});

describe('webhook controller routing', () => {
    const DEFAULT_SECRET = 'whsec_default_test';
    const LD_SECRET = 'whsec_licensedock_test';
    let hold: { channelForToken: ReturnType<typeof vi.fn>; handleEvent: ReturnType<typeof vi.fn> };
    let controller: StripeHoldController;

    beforeEach(() => {
        vi.stubEnv('STRIPE_CG_WEBHOOK_SECRET_LICENSEDOCK', LD_SECRET);
        configureStripeHold({ getOptions: () => ({ webhookSecret: DEFAULT_SECRET }) });
        hold = {
            channelForToken: vi.fn(async (token: string) => channels.find(c => c.token === token)),
            handleEvent: vi.fn(async () => ({ status: 200, message: 'hold handled' })),
        };
        controller = new StripeHoldController(hold as any, svc);
    });

    async function deliver(payload: object, secret: string) {
        const raw = Buffer.from(JSON.stringify(payload));
        const res: any = { statusCode: 0, body: undefined, headersSent: false };
        res.status = (code: number) => { res.statusCode = code; return res; };
        res.send = (body: any) => { res.body = body; res.headersSent = true; return res; };
        await controller.webhook(buildStripeSignatureHeader(raw, secret), { rawBody: raw, body: raw, headers: {} } as any, res);
        return res;
    }

    it('sends a bank-transfer intent to the bank-transfer service, verified with its channel\'s secret', async () => {
        routeOrderPayments(() => [{ orderId: 10, paymentId: 41, metadata: stripeMetadata() }]);
        conn.repo(Payment).rows = [stripePayment()];
        const handle = vi.spyOn(svc, 'handleStripeEvent');
        const ok = await deliver(event('payment_intent.succeeded'), LD_SECRET);
        expect(ok).toMatchObject({ statusCode: 200, body: 'Bank transfer pi_bt123 settled for order ORD1' });
        expect(handle).toHaveBeenCalledTimes(1);
        expect(hold.handleEvent).not.toHaveBeenCalled();
        // cg_channel_id 2 → channel `licensedock` → STRIPE_CG_WEBHOOK_SECRET_LICENSEDOCK. Signed for the other
        // account's endpoint, it is acknowledged but never acted on.
        expect(await deliver(event('payment_intent.succeeded'), DEFAULT_SECRET)).toMatchObject({ statusCode: 200, body: 'Signed for another account\'s endpoint; ignored' });
        // A secret that is not configured at all is refused.
        expect(await deliver(event('payment_intent.succeeded'), 'whsec_forged')).toMatchObject({ statusCode: 400, body: 'Error verifying Stripe webhook signature' });
        expect(handle).toHaveBeenCalledTimes(1);
        expect(conn.log.filter(l => l.startsWith('settle:'))).toEqual(['settle:41']);
    });

    it('looks a cg_channel_id up only when it is a plain id, and only once a minute', async () => {
        await deliver(event('payment_intent.requires_action', { metadata: { cg_bank_transfer: '1', cg_order_code: 'ORD1', cg_channel_id: "2' OR 1=1" } }), DEFAULT_SECRET);
        const findOne = conn.repo(Channel).findOne;
        expect(findOne).not.toHaveBeenCalled();
        await deliver(event('payment_intent.requires_action'), LD_SECRET);
        await deliver(event('payment_intent.requires_action'), LD_SECRET);
        expect(findOne).toHaveBeenCalledTimes(1);
    });

    it('accepts an event without metadata from another configured account and lets the hold service skip it', async () => {
        // e.g. a sale of another system on the second account, delivered by the endpoint signed with its secret.
        const foreign = { type: 'payment_intent.succeeded', data: { object: { id: 'pi_lic1', status: 'succeeded', metadata: { licence: 'x' } } } };
        expect(await deliver(foreign, LD_SECRET)).toMatchObject({ statusCode: 200, body: 'hold handled' });
        expect(hold.handleEvent).toHaveBeenCalledTimes(1);
        // With Stripe bank transfers off, the secret is chosen exactly as in 0.2.9.
        setBankTransferRuntime({ expiryDays: 7, reminderAfterDays: 3 });
        expect(await deliver(foreign, LD_SECRET)).toMatchObject({ statusCode: 400 });
        expect(hold.handleEvent).toHaveBeenCalledTimes(1);
    });

    it('routes cash balance transactions to the bank-transfer service only while the mode is on', async () => {
        const cash = vi.spyOn(svc, 'handleCashBalanceEvent').mockResolvedValue({ status: 200, message: 'cash' });
        const txn = { type: 'customer_cash_balance_transaction.created', data: { object: { id: 'ccsbtxn_1', object: 'customer_cash_balance_transaction', customer: 'cus_123' } } };
        expect(await deliver(txn, LD_SECRET)).toMatchObject({ statusCode: 200, body: 'cash' });
        setBankTransferRuntime({ expiryDays: 7, reminderAfterDays: 3 });
        expect(await deliver(txn, DEFAULT_SECRET)).toMatchObject({ statusCode: 200, body: 'hold handled' });
        expect(cash).toHaveBeenCalledTimes(1);
    });

    it('leaves every other intent to the hold service, as before', async () => {
        const handle = vi.spyOn(svc, 'handleStripeEvent');
        const holdEvent = { type: 'payment_intent.amount_capturable_updated', data: { object: { id: 'pi_hold1', status: 'requires_capture', metadata: { channelToken: 'tok-ld', orderCode: 'ORD9', orderId: '99' } } } };
        expect(await deliver(holdEvent, LD_SECRET)).toMatchObject({ statusCode: 200, body: 'hold handled' });
        const plain = { type: 'payment_intent.succeeded', data: { object: { id: 'pi_card1', status: 'succeeded', metadata: {} } } };
        expect(await deliver(plain, DEFAULT_SECRET)).toMatchObject({ statusCode: 200, body: 'hold handled' });
        expect(hold.handleEvent).toHaveBeenCalledTimes(2);
        expect(hold.channelForToken).toHaveBeenCalledWith('tok-ld');
        expect(handle).not.toHaveBeenCalled();
    });
});

describe('hold webhook while premium is locked', () => {
    const card = (capture_method: string) => ({
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_card1', status: 'succeeded', capture_method, amount: 1000, currency: 'gbp', metadata: { channelToken: 'tok-ld', orderCode: 'ORD9', orderId: '9' } } },
    });
    let holds: StripeHoldService;
    let flag = true;

    beforeEach(() => {
        vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
        flag = true;
        configureStripeHold({ getOptions: () => ({}), hasPremiumAccess: () => false, notifyOps: async () => undefined, acknowledgeNonHoldEventsWhileLocked: () => flag });
        holds = new StripeHoldService({} as any, {} as any, {} as any, {} as any);
    });
    afterEach(() => configureStripeHold({ acknowledgeNonHoldEventsWhileLocked: () => false }));

    it('acknowledges a card payment\'s success when Stripe bank transfers share the endpoint', async () => {
        expect(await holds.handleEvent(card('automatic'))).toEqual({ status: 200, message: 'Event payment_intent.succeeded is not for a hold; ignored while Checkout Guard premium is locked' });
    });

    it('still answers 503 for a hold, and for everything when the flag is off (0.2.9)', async () => {
        expect((await holds.handleEvent(card('manual'))).status).toBe(503);
        flag = false;
        expect((await holds.handleEvent(card('automatic'))).status).toBe(503);
    });
});

describe('sweep fallback (syncStripe)', () => {
    const NOW = new Date('2026-11-06T12:05:00.000Z');
    function routeOpen(rows: any[]) {
        sqlRoutes.push({ re: /p\.metadata LIKE \? ORDER BY/, rows: () => rows });
    }

    it('does nothing at all while Stripe bank transfers are off', async () => {
        setBankTransferRuntime({ expiryDays: 7, reminderAfterDays: 3, hasPremiumAccess: () => premium });
        expect(await svc.syncStripe(NOW)).toEqual({ checked: 0, settled: 0, awaiting: 0, skipped: 'disabled' });
        expect(conn.queries).toHaveLength(0);
        expect(stripe.calls).toHaveLength(0);
    });

    it('settles a transfer whose PaymentIntent has succeeded (the webhook was missed)', async () => {
        routeOpen([
            { paymentId: 41, metadata: JSON.stringify(stripeMetadata()) },
            { paymentId: 42, metadata: JSON.stringify({ public: { method: 'bank-transfer', paymentIntentIdNote: 'x' } }) }, // static: skipped
        ]);
        routeOrderPayments(() => [{ orderId: 10, paymentId: 41, metadata: stripeMetadata() }]);
        conn.repo(Payment).rows = [stripePayment()];
        stripe.respond(() => ({ body: stripeBankTransferIntent({ status: 'succeeded', amount_received: 12999, next_action: null }) }));
        expect(await svc.syncStripe(NOW)).toEqual({ checked: 1, settled: 1, awaiting: 0, skipped: null });
        const [open] = conn.ran(/p\.metadata LIKE \? ORDER BY/);
        expect(open.params).toEqual(['bank-transfer', '%paymentIntentId%']);
        // Only orders still awaiting payment, newest first.
        expect(open.sql).toContain("o.state = 'PaymentAuthorized'");
        expect(open.sql).toContain('ORDER BY p.`createdAt` DESC');
        expect(stripe.calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /v1/payment_intents/pi_bt123']);
        expect(stripe.calls[0].headers.Authorization).toBe('Bearer sk_test_bt');
        expect(conn.log).toEqual(['tx:start', 'settle:41', 'tx:end']);
        expect(conn.ran(/SET settledAt = NOW\(\) WHERE paymentId = \?/)[0].params).toEqual([41]);
    });

    it('keeps a partly funded transfer open, logs amount_remaining when it changes and updates the amount due', async () => {
        routeOpen([{ paymentId: 41, metadata: stripeMetadata() }]);
        conn.repo(Payment).rows = [stripePayment()];
        let remaining = 5000;
        stripe.respond(() => ({ body: stripeBankTransferIntent({ instructions: { amount_remaining: remaining } }) }));
        expect(await svc.syncStripe(NOW)).toEqual({ checked: 1, settled: 0, awaiting: 1, skipped: null });
        const partLogs = () => info.mock.calls.filter(c => /partly paid/.test(String(c[0])));
        expect(partLogs().map(c => c[0])).toEqual([expect.stringContaining('£79.99 received, amount_remaining £50.00')]);
        expect(JSON.parse(conn.ran(/UPDATE payment SET metadata/)[0].params[0]).public.amountMinor).toBe(5000);
        await svc.syncStripe(new Date(NOW.getTime() + 10 * MIN));
        expect(partLogs()).toHaveLength(1); // unchanged: not logged again
        remaining = 2000;
        await svc.syncStripe(new Date(NOW.getTime() + 20 * MIN));
        expect(partLogs().map(c => c[0])[1]).toContain('amount_remaining £20.00');
        expect(JSON.parse(conn.ran(/UPDATE payment SET metadata/).at(-1)!.params[0]).public.amountMinor).toBe(2000);
        expect(orders.settlePayment).not.toHaveBeenCalled();
    });

    it('asks Stripe about one transfer at most once every ten minutes', async () => {
        routeOpen([{ paymentId: 41, metadata: stripeMetadata() }]);
        conn.repo(Payment).rows = [stripePayment()];
        await svc.syncStripe(NOW);
        await svc.syncStripe(NOW);
        await svc.syncStripe(new Date(NOW.getTime() + 9 * MIN));
        expect(stripe.calls).toHaveLength(1);
        await svc.syncStripe(new Date(NOW.getTime() + 10 * MIN));
        expect(stripe.calls).toHaveLength(2);
    });

    it('stops starting checks once its three minutes are used up, so it never holds the lock into the next sweep', async () => {
        routeOpen([{ paymentId: 41, metadata: stripeMetadata() }, { paymentId: 43, metadata: stripeMetadata({ paymentIntentId: 'pi_second' }) }]);
        conn.repo(Payment).rows = [stripePayment(), stripePayment({ id: 43, metadata: stripeMetadata({ paymentIntentId: 'pi_second' }) })];
        let clock = NOW.getTime();
        vi.spyOn(Date, 'now').mockImplementation(() => clock);
        stripe.respond(() => { clock += 3 * MIN + 1; return { body: stripeBankTransferIntent() }; }); // a Stripe answer that takes over three minutes
        const r = await svc.syncStripe(NOW);
        expect(r.checked).toBe(1);
        expect(stripe.calls).toHaveLength(1);
    });

    it('skips payments that are no longer Authorized and survives Stripe errors', async () => {
        routeOpen([{ paymentId: 41, metadata: stripeMetadata() }]);
        conn.repo(Payment).rows = [stripePayment({ state: 'Settled' })];
        expect(await svc.syncStripe(NOW)).toEqual({ checked: 0, settled: 0, awaiting: 0, skipped: null });
        expect(stripe.calls).toHaveLength(0);

        conn.repo(Payment).rows = [stripePayment()];
        stripe.respond(() => ({ status: 500, body: { error: { type: 'api_error', message: 'boom' } } }));
        expect(await svc.syncStripe(new Date(NOW.getTime() + 10 * MIN))).toEqual({ checked: 0, settled: 0, awaiting: 0, skipped: null });
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Stripe check of bank transfer payment 41 failed: api_error/), 'CheckoutGuard');
    });

    it('never polls a transfer whose order was cancelled or paid some other way', async () => {
        routeOpen([{ paymentId: 41, metadata: stripeMetadata() }]);
        conn.repo(Payment).rows = [stripePayment({ order: { ...ORDER, state: 'Cancelled' } })];
        expect(await svc.syncStripe(NOW)).toEqual({ checked: 0, settled: 0, awaiting: 0, skipped: null });
        expect(stripe.calls).toHaveLength(0);
    });

    it('alerts an intent cancelled at Stripe while the order still waits, once, and not a cancel still committing', async () => {
        routeOpen([{ paymentId: 41, metadata: stripeMetadata() }]);
        conn.repo(Payment).rows = [stripePayment()];
        let canceledAt = Math.floor(NOW.getTime() / 1000) - 30;
        stripe.respond(() => ({ body: stripeBankTransferIntent({ status: 'canceled', next_action: null, canceled_at: canceledAt }) }));
        await svc.syncStripe(NOW);
        expect(notify).not.toHaveBeenCalled();
        canceledAt = Math.floor(NOW.getTime() / 1000) - 3600;
        await svc.syncStripe(new Date(NOW.getTime() + 10 * MIN));
        await svc.syncStripe(new Date(NOW.getTime() + 20 * MIN));
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({ event: 'bank.stripe_unsettled', orderCode: 'ORD1', paymentIntentId: 'pi_bt123' });
        expect(notify.mock.calls[0][0].text).toMatch(/can no longer complete it/);
    });
});

describe('expiry sweep with Stripe bank transfers', () => {
    function routeCandidate(metadataOver: Record<string, any> = {}, overdueDays = 3) {
        const metadata = stripeMetadata({ public: { ...stripeMetadata().public, payBy: days(overdueDays).toISOString() }, ...metadataOver });
        sqlRoutes.push({ re: /MAX\(occ\.`channelId`\) AS channelId, t\.reminderSentAt/, rows: () => [{
            paymentId: 41, orderId: 10, orderCode: 'ORD1', channelId: 2, paymentCreatedAt: days(10), amount: 12999, metadata: JSON.stringify(metadata), reminderSentAt: null,
        }] });
        conn.repo(Payment).rows = [stripePayment({ createdAt: days(10), metadata })];
    }

    beforeEach(() => wireHandlerThroughVendure());

    it('checks Stripe, then expires the order and cancels its PaymentIntent', async () => {
        routeCandidate();
        const r = await svc.sweep();
        expect(r).toEqual({ scanned: 1, expired: 1, reminded: 0, repaired: 0, skipped: null });
        expect(stripe.calls.map(c => `${c.method} ${c.path}`)).toEqual([
            'GET /v1/payment_intents/pi_bt123', 'GET /v1/payment_intents/pi_bt123', 'POST /v1/payment_intents/pi_bt123/cancel',
        ]);
        expect(stripe.calls[2].form).toEqual({ cancellation_reason: 'abandoned' });
        expect(stripe.calls[2].headers.Authorization).toBe('Bearer sk_test_bt');
        expect(conn.log).toEqual(['tx:start', 'cancelPayment:41', 'tx:end', 'cancelOrder:10']);
        expect(eventBus.publish.mock.calls[0][0]).toBeInstanceOf(BankTransferExpiredEvent);
        expect(notify).not.toHaveBeenCalled();
    });

    it('settles instead of expiring when Stripe has the money', async () => {
        routeCandidate();
        routeOrderPayments(() => [{ orderId: 10, paymentId: 41, metadata: stripeMetadata() }]);
        stripe.respond(() => ({ body: stripeBankTransferIntent({ status: 'succeeded', amount_received: 12999, next_action: null }) }));
        expect(await svc.sweep()).toEqual({ scanned: 1, expired: 0, reminded: 0, repaired: 0, skipped: null });
        expect(conn.log).toEqual(['tx:start', 'settle:41', 'tx:end']);
        expect(conn.repo(Payment).rows[0].metadata).toMatchObject({ settledBy: 'stripe' });
        expect(stripe.calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /v1/payment_intents/pi_bt123']); // the handler trusts the sweep's look
        expect(conn.ran(/SET expiredAt/)).toHaveLength(0);
        expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('does not expire a transfer it could not check with Stripe, and alerts once it is a day overdue', async () => {
        routeCandidate({}, 0.5);
        stripe.respond(() => ({ status: 503, body: {} }));
        expect(await svc.sweep()).toEqual({ scanned: 1, expired: 0, reminded: 0, repaired: 0, skipped: null });
        expect(orders.cancelPayment).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ORD1 not expired on this pass/), 'CheckoutGuard');
        expect(notify).not.toHaveBeenCalled();

        sqlRoutes = sqlRoutes.filter(r => !/reminderSentAt/.test(String(r.re)));
        routeCandidate({}, 2);
        await svc.sweep();
        await svc.sweep();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({ event: 'bank.stripe_check_failed', orderCode: 'ORD1', paymentIntentId: 'pi_bt123' });
    });

    it('expires as usual when Stripe says the intent is not on the channel\'s account, and asks for it to be cancelled', async () => {
        routeCandidate();
        stripe.respond(() => ({ status: 404, body: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such payment_intent' } } }));
        expect((await svc.sweep()).expired).toBe(1);
        expect(conn.log).toEqual(['tx:start', 'cancelPayment:41', 'tx:end', 'cancelOrder:10']);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'bank.stripe_cancel_failed', orderCode: 'ORD1', paymentIntentId: 'pi_bt123' }));
    });

    it('expires a partly paid transfer and asks for the part payment to be refunded', async () => {
        routeCandidate();
        stripe.respond(call => call.method === 'GET'
            ? { body: stripeBankTransferIntent({ instructions: { amount_remaining: 5000 } }) }
            : { body: { id: 'pi_bt123', status: 'canceled' } });
        expect((await svc.sweep()).expired).toBe(1);
        await flushAsync();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({ event: 'bank.stripe_partially_funded', orderCode: 'ORD1', amountMinor: 7999, paymentIntentId: 'pi_bt123' });
        expect(notify.mock.calls[0][0].text).toMatch(/cancelled with £79\.99 of £129\.99 already paid .*cash balance.*refund it from the Stripe dashboard/);
    });

    it('words the part-payment alert by the cancel\'s outcome', async () => {
        routeCandidate();
        stripe.respond(call => call.method === 'GET'
            ? { body: stripeBankTransferIntent({ instructions: { amount_remaining: 5000 } }) }
            : { status: 500, body: { error: { type: 'api_error', message: 'boom' } } });
        expect((await svc.sweep()).expired).toBe(1);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({ event: 'bank.stripe_cancel_failed', paymentIntentId: 'pi_bt123' });
        expect(notify.mock.calls[0][0].text).toMatch(/could not be \(api_error.*£79\.99 of £129\.99 had already arrived/);
        expect(notify.mock.calls[0][0].text).not.toMatch(/was cancelled, so that money/);
    });

    it('leaves the order Authorized when Stripe reports the money arrived during the cancel', async () => {
        routeCandidate();
        stripe.respond(call => {
            if (call.method === 'POST') return { status: 400, body: { error: { code: 'payment_intent_unexpected_state', message: 'This PaymentIntent has a status of succeeded.' } } };
            // The expiry check and the handler's look still see it open; the look after the refused cancel sees it paid.
            return { body: stripe.to(/^GET /).length > 2 ? stripeBankTransferIntent({ status: 'succeeded', next_action: null }) : stripeBankTransferIntent() };
        });
        expect((await svc.sweep()).expired).toBe(0);
        expect(orders.cancelOrder).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Could not expire bank transfer for order ORD1: cancel_payment_failed: bank-transfer: the customer has already paid/), 'CheckoutGuard');
    });

    it('leaves a transfer with the payment method\'s own details exactly as before', async () => {
        const metadata = { public: { method: 'bank-transfer', payBy: days(3).toISOString(), currency: 'GBP' } };
        sqlRoutes.push({ re: /MAX\(occ\.`channelId`\) AS channelId, t\.reminderSentAt/, rows: () => [{ paymentId: 41, orderId: 10, orderCode: 'ORD1', channelId: 2, paymentCreatedAt: days(10), amount: 12999, metadata: JSON.stringify(metadata), reminderSentAt: null }] });
        conn.repo(Payment).rows = [stripePayment({ createdAt: days(10), metadata })];
        expect((await svc.sweep()).expired).toBe(1);
        expect(stripe.calls).toHaveLength(0);
        expect(conn.log).toEqual(['tx:start', 'cancelPayment:41', 'tx:end', 'cancelOrder:10']);
    });
});

describe('Vendure\'s own cancellations and hand settlement', () => {
    beforeEach(() => wireHandlerThroughVendure());

    it('cancels the Stripe transfer of an order cancelled outside Checkout Guard, which cancels its PaymentIntent', async () => {
        sqlRoutes.push({ re: /WHERE p\.`orderId` = \? AND p\.state = 'Authorized'/, rows: () => [{ paymentId: 41, metadata: JSON.stringify(stripeMetadata()) }] });
        conn.repo(Payment).rows = [stripePayment({ order: { ...ORDER, state: 'Cancelled' } })];
        expect(await svc.releaseCancelledOrder({ id: 10, code: 'ORD1' })).toBe(1);
        expect(conn.log).toEqual(['tx:start', 'cancelPayment:41', 'tx:end']);
        expect(stripe.to(/POST \/v1\/payment_intents\/pi_bt123\/cancel$/)).toHaveLength(1);
        expect(conn.ran(/SET cancelledAt = COALESCE\(cancelledAt, NOW\(\)\) WHERE paymentId = \?/)[0].params).toEqual([41]);
    });

    it('alerts when the cancelled order had been paid through Stripe', async () => {
        sqlRoutes.push({ re: /WHERE p\.`orderId` = \? AND p\.state = 'Authorized'/, rows: () => [{ paymentId: 41, metadata: stripeMetadata() }] });
        conn.repo(Payment).rows = [stripePayment({ order: { ...ORDER, state: 'Cancelled' } })];
        stripe.respond(() => ({ body: stripeBankTransferIntent({ status: 'succeeded', next_action: null }) }));
        expect(await svc.releaseCancelledOrder({ id: 10, code: 'ORD1' })).toBe(0);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'bank.stripe_unsettled', orderCode: 'ORD1', paymentIntentId: 'pi_bt123' }));
    });

    it('listens for orders moving to Cancelled while the mode is on', async () => {
        let emit: (e: any) => void = () => undefined;
        const bus: any = { publish: vi.fn(), ofType: vi.fn(() => ({ subscribe: (fn: any) => { emit = fn; } })) };
        const service = new BankTransferService(conn as any, orders as any, fakeRequestContextService(channels) as any, bus);
        const release = vi.spyOn(service, 'releaseCancelledOrder').mockResolvedValue(0);
        service.onApplicationBootstrap();
        expect(bus.ofType).toHaveBeenCalledWith(OrderStateTransitionEvent);
        emit({ toState: 'PaymentSettled', order: { id: 10 } });
        emit({ toState: 'Cancelled', order: { id: 10, code: 'ORD1' } });
        setBankTransferRuntime({ expiryDays: 7, reminderAfterDays: 3 });
        emit({ toState: 'Cancelled', order: { id: 11, code: 'ORD2' } });
        expect(release.mock.calls).toEqual([[{ id: 10, code: 'ORD1' }]]);
    });

    it('"Mark received" on a Stripe transfer cancels its PaymentIntent and records the settlement as by hand', async () => {
        conn.repo(Payment).rows = [stripePayment()];
        const r = await svc.markReceived(41);
        expect(r.ok).toBe(true);
        expect(stripe.calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /v1/payment_intents/pi_bt123', 'POST /v1/payment_intents/pi_bt123/cancel']);
        expect(conn.repo(Payment).rows[0].metadata).toMatchObject({ settledBy: 'hand', stripeStatus: 'canceled' });
    });
});
