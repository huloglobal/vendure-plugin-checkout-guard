import { createHash } from 'crypto';
import { ID, Logger } from '@vendure/core';

import { cancelIdempotencyKey, fromStripeMinorUnits, isPaymentIntentId, toStripeMinorUnits } from '../stripe-hold/hold-utils';
import {
    FetchLike, StripePaymentIntentLike, StripeRequestError, StripeRequestOptions, cancelPaymentIntent, encodeForm, isUnexpectedStateError,
    retrievePaymentIntent, stripeRequest,
} from '../stripe-hold/stripe-api';
import { BANK_TRANSFER_HANDLER_CODE, BankTransferPublicDetails, buildBankTransferPublicDetails } from './bank-details';

/**
 * Stripe bank transfers for the `bank-transfer` handler (opt-in,
 * `bankTransfer.stripe.enabled`).
 *
 * Instead of the payment method's own account details, the customer gets
 * a virtual account Stripe keeps for them (customer balance, funding type
 * `bank_transfer`) and Stripe's reference. Stripe matches the incoming
 * Faster Payment or BACS credit to the PaymentIntent and fires
 * `payment_intent.succeeded`; the webhook (and the ten-minute sweep, if the
 * webhook is missed) settles the Vendure payment. Everything here is plain
 * REST over the package's own Stripe client, so tests run on a stubbed fetch.
 *
 * Who owns the Stripe customer matters: Stripe applies a customer's whole
 * cash balance to a new PaymentIntent the moment it is confirmed. So an
 * existing Stripe customer is reused only when the checkout is signed in as
 * the Vendure customer it was created for (a guest checkout proves nothing:
 * anyone can type an e-mail address). Every other checkout gets a Stripe
 * customer of its own, which never holds a balance.
 */

const loggerCtx = 'CheckoutGuard';

/** Host options: `CheckoutGuardPlugin.init({ bankTransfer: { stripe: { ... } } })`. */
export interface StripeBankTransferOptions {
    /** Send bank-transfer orders through Stripe. Default `false`: the payment method's own details, as before. */
    enabled?: boolean;
    /**
     * Order currencies that go through Stripe. Default `['GBP']` (UK sort code and
     * account number, `gb_bank_transfer`). `EUR` (`eu_bank_transfer`, an IBAN) also
     * works when `euCountry` is set. Orders in any other currency keep the payment
     * method's own details.
     */
    currencies?: string[];
    /** Country of the IBAN Stripe issues for EUR transfers: `BE`, `DE`, `FR`, `IE` or `NL`. Needed for EUR. */
    euCountry?: string;
    /** Replaces the default customer instructions; `{reference}` is replaced with Stripe's reference. */
    instructions?: string;
}

/** Options after validation; `null` in the runtime means the mode is off. */
export interface StripeBankTransferSettings {
    /** Upper-case ISO codes that go through Stripe. */
    currencies: string[];
    euCountry: string | null;
    instructions: string | null;
}

export type StripeBankTransferType = 'gb_bank_transfer' | 'eu_bank_transfer';

/** The bank-transfer types this version can request, by order currency. */
export const STRIPE_BANK_TRANSFER_TYPES: Readonly<Record<string, StripeBankTransferType>> = Object.freeze({
    GBP: 'gb_bank_transfer',
    EUR: 'eu_bank_transfer',
});

/** Countries Stripe currently issues new EUR virtual accounts in (Spain is listed by Stripe as unavailable for new ones). */
const EU_COUNTRIES = ['BE', 'DE', 'FR', 'IE', 'NL'];

/** Budget for everything one checkout asks Stripe (customer lookup or creation, PaymentIntent). */
export const STRIPE_BANK_TRANSFER_TIMEOUT_MS = 15_000;

/** PaymentIntent metadata keys. Deliberately not Vendure's StripePlugin keys
 *  (`channelToken`, `orderId`, `orderCode`, `languageCode`): its webhook must
 *  skip these intents rather than try to add a card payment for them. */
export const STRIPE_BANK_TRANSFER_METADATA = Object.freeze({
    flag: 'cg_bank_transfer',
    orderCode: 'cg_order_code',
    orderId: 'cg_order_id',
    channelId: 'cg_channel_id',
});

/**
 * Stripe customer metadata keys. `cg_vendure_user_id` is set only on a
 * customer created while the checkout was signed in as that Vendure
 * customer, and only such a customer is ever reused. A customer created for
 * any other checkout carries the order code instead and serves that order alone.
 */
export const STRIPE_BANK_TRANSFER_CUSTOMER_METADATA = Object.freeze({
    customerId: 'cg_vendure_customer_id',
    userId: 'cg_vendure_user_id',
    orderCode: 'cg_order_code',
});

const warned = new Set<string>();
function warnOnce(message: string): void {
    if (warned.has(message)) return;
    warned.add(message);
    Logger.warn(message, loggerCtx);
}

/** Validate the host options. Unsupported currencies are dropped with a warning (their orders keep the static details). */
export function normaliseStripeBankTransferOptions(opts?: StripeBankTransferOptions | null): StripeBankTransferSettings | null {
    if (!opts || opts.enabled !== true) return null;
    const rawCountry = typeof opts.euCountry === 'string' ? opts.euCountry.trim().toUpperCase() : '';
    const euCountry = EU_COUNTRIES.includes(rawCountry) ? rawCountry : null;
    if (rawCountry && !euCountry) {
        warnOnce(`bankTransfer.stripe.euCountry "${opts.euCountry}" is not a country Stripe issues new IBANs in (${EU_COUNTRIES.join(', ')}); it is ignored`);
    }
    const requested = Array.isArray(opts.currencies) && opts.currencies.length ? opts.currencies : ['GBP'];
    const currencies: string[] = [];
    for (const raw of requested) {
        const code = String(raw ?? '').trim().toUpperCase();
        if (!code || currencies.includes(code)) continue;
        if (!STRIPE_BANK_TRANSFER_TYPES[code]) {
            warnOnce(`Stripe bank transfers: ${code} is not supported (GBP and EUR are); ${code} orders keep the payment method's own bank details`);
            continue;
        }
        if (code === 'EUR' && !euCountry) {
            warnOnce(`Stripe bank transfers: EUR needs bankTransfer.stripe.euCountry (${EU_COUNTRIES.join(', ')}); EUR orders keep the payment method's own bank details`);
            continue;
        }
        currencies.push(code);
    }
    const instructions = typeof opts.instructions === 'string' && opts.instructions.trim() ? opts.instructions.trim() : null;
    return { currencies, euCountry, instructions };
}

/** Stripe dedupes a retried checkout of the same order and amount onto one PaymentIntent. */
export function bankTransferIdempotencyKey(orderCode: string, stripeAmount: number): string {
    return `cg-bt-${orderCode}-${stripeAmount}`;
}

/** The customer create key: per order, and per exact request, so a retry with changed details is not refused by Stripe. */
export function bankTransferCustomerIdempotencyKey(orderCode: string, params: Record<string, unknown>): string {
    return `cg-bt-customer-${orderCode}-${createHash('sha256').update(encodeForm(params)).digest('hex').slice(0, 16)}`;
}

/** `200000` → `20-00-00`. Anything that is not six digits is returned as Stripe sent it. */
export function formatSortCode(value: string | null | undefined): string {
    const raw = String(value ?? '').trim();
    const digits = raw.replace(/\D/g, '');
    return digits.length === 6 ? `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}` : raw;
}

/** A PaymentIntent create whose outcome is unknown (no answer in time, a network failure or a Stripe 5xx). */
export interface StrayBankTransferIntent {
    customerId: string;
    orderCode: string;
    /** Unix seconds a little before the request was sent: the earliest the intent can have been created. */
    sinceSec: number;
    /** Set when the intent is known but could not be used. */
    paymentIntentId?: string;
}

export type StripeBankTransferFailureReason =
    | 'no_key' | 'no_customer' | 'unsupported_currency' | 'timeout' | 'api_error' | 'unexpected_status' | 'missing_instructions'
    /** Stripe paid (part of) the intent from a cash balance, but the checkout was not signed in as that customer. */
    | 'balance_applied';

export class StripeBankTransferError extends Error {
    /** A PaymentIntent that may exist although checkout did not get to use it: the handler has it found and cancelled. */
    readonly stray?: StrayBankTransferIntent;
    /** The intent the failure concerns, when known. */
    readonly paymentIntentId?: string;
    /** Its status at Stripe, when known. */
    readonly intentStatus?: string;

    constructor(
        public readonly reason: StripeBankTransferFailureReason,
        message: string,
        extra: { stray?: StrayBankTransferIntent; paymentIntentId?: string; intentStatus?: string } = {},
    ) {
        super(message);
        this.name = 'StripeBankTransferError';
        this.stray = extra.stray;
        this.paymentIntentId = extra.paymentIntentId ?? extra.stray?.paymentIntentId;
        this.intentStatus = extra.intentStatus;
    }
}

/** One line for logs and alerts. Never includes request headers (the secret key). */
export function describeStripeFailure(e: unknown): string {
    if (e instanceof StripeBankTransferError) return `${e.reason}: ${e.message}`;
    if (e instanceof StripeRequestError) return `api_error: ${e.code || e.type || `HTTP ${e.status}`}: ${e.message}`;
    const err = e as { name?: string; message?: string } | null;
    if (err?.name === 'AbortError' || /aborted|timed? ?out/i.test(String(err?.message || ''))) return 'timeout: no answer from Stripe in time';
    return `error: ${err?.message || String(e)}`;
}

/** Stripe's answer says nothing was done (a 4xx other than 409, or a check of our own). */
function definitelyNotCreated(e: unknown): boolean {
    if (e instanceof StripeBankTransferError) return true;
    return e instanceof StripeRequestError && e.status < 500 && e.status !== 409;
}

/** Stripe answered that the object does not exist on this account, or that the key is not allowed to see it. */
export function isMissingAtStripe(e: unknown): boolean {
    return e instanceof StripeRequestError && (e.status === 401 || e.status === 403 || e.status === 404 || e.code === 'resource_missing');
}

// ── Stripe shapes (only the fields read here) ─────────────────────────

export interface StripeFinancialAddressLike {
    type?: string;
    sort_code?: { account_holder_name?: string | null; account_number?: string | null; sort_code?: string | null } | null;
    iban?: { account_holder_name?: string | null; iban?: string | null; bic?: string | null; country?: string | null } | null;
}

export interface StripeBankTransferInstructionsLike {
    type?: string;
    reference?: string | null;
    amount_remaining?: number | null;
    currency?: string | null;
    hosted_instructions_url?: string | null;
    financial_addresses?: StripeFinancialAddressLike[] | null;
}

export interface StripeBankTransferIntentLike extends StripePaymentIntentLike {
    customer?: string | { id: string } | null;
    cancellation_reason?: string | null;
    next_action?: { type?: string; display_bank_transfer_instructions?: StripeBankTransferInstructionsLike | null } | null;
}

interface StripeCustomerLike {
    id?: string;
    deleted?: boolean;
    metadata?: Record<string, string> | null;
}

/** What has arrived so far, in Stripe minor units. `remaining` is null when Stripe did not say. */
export function stripeTransferFunding(pi: StripeBankTransferIntentLike): { remaining: number | null; received: number; partlyFunded: boolean } {
    const raw = pi?.next_action?.display_bank_transfer_instructions?.amount_remaining;
    const amount = Number(pi?.amount) || 0;
    const remaining = raw === null || raw === undefined || !Number.isFinite(Number(raw)) ? null : Math.max(0, Number(raw));
    const received = remaining === null ? 0 : Math.max(0, amount - remaining);
    return { remaining, received, partlyFunded: pi?.status === 'requires_action' && remaining !== null && remaining > 0 && remaining < amount };
}

// ── Payment metadata ──────────────────────────────────────────────────

function metadataObject(metadata: unknown): Record<string, any> | null {
    let m: any = metadata;
    if (typeof m === 'string') {
        try { m = JSON.parse(m); } catch { return null; }
    }
    return m && typeof m === 'object' ? m : null;
}

/** The PaymentIntent behind a Stripe-backed bank-transfer payment (non-public metadata), else null. */
export function stripePaymentIntentIdOf(paymentMetadata: unknown): string | null {
    const id = metadataObject(paymentMetadata)?.paymentIntentId;
    return isPaymentIntentId(id) ? id : null;
}

/** The channel whose Stripe key created the PaymentIntent, else null. */
export function stripeChannelIdOf(paymentMetadata: unknown): string | null {
    const id = metadataObject(paymentMetadata)?.stripeChannelId;
    return id === undefined || id === null || String(id).trim() === '' ? null : String(id).trim();
}

/** The Stripe customer behind a Stripe-backed bank-transfer payment, else null. */
export function stripeCustomerIdOf(paymentMetadata: unknown): string | null {
    const id = metadataObject(paymentMetadata)?.stripeCustomerId;
    return typeof id === 'string' && /^cus_[A-Za-z0-9]+$/.test(id) ? id : null;
}

/** True when the payment was settled because Stripe received the transfer (not marked received by hand). */
export function settledThroughStripe(paymentMetadata: unknown): boolean {
    const m = metadataObject(paymentMetadata);
    if (!m) return false;
    if (m.settledBy === 'stripe') return true;
    return m.settledBy === undefined && m.stripeStatus === 'succeeded';
}

/** PaymentIntent metadata written by `createStripeBankTransfer`, or null for every other intent. */
export function parseBankTransferStripeMetadata(metadata: unknown): { orderCode: string; orderId: string | null; channelId: string } | null {
    if (!metadata || typeof metadata !== 'object') return null;
    const m = metadata as Record<string, unknown>;
    if (String(m[STRIPE_BANK_TRANSFER_METADATA.flag] ?? '') !== '1') return null;
    const orderCode = typeof m[STRIPE_BANK_TRANSFER_METADATA.orderCode] === 'string' ? String(m[STRIPE_BANK_TRANSFER_METADATA.orderCode]).trim() : '';
    const channelRaw = m[STRIPE_BANK_TRANSFER_METADATA.channelId];
    const channelId = channelRaw === undefined || channelRaw === null ? '' : String(channelRaw).trim();
    if (!orderCode || !channelId || channelId.length > 64) return null;
    const orderRaw = m[STRIPE_BANK_TRANSFER_METADATA.orderId];
    const orderId = orderRaw === undefined || orderRaw === null || String(orderRaw).trim() === '' ? null : String(orderRaw).trim();
    return { orderCode, orderId, channelId };
}

// ── Intents known to have succeeded (this process) ────────────────────

/**
 * PaymentIntents this process has seen succeed (a signed webhook event, or
 * a live retrieve by the sweep) shortly before settling their payment. The
 * handler's `settlePayment` then knows the settlement is Stripe's own and
 * needs no second look; anything else is a settlement by hand.
 */
const knownSucceeded = new Map<string, number>();
const KNOWN_SUCCEEDED_TTL_MS = 15 * 60_000;

export function noteStripeTransferSucceeded(paymentIntentId: string, now: number = Date.now()): void {
    if (knownSucceeded.size >= 2000) {
        for (const [id, at] of knownSucceeded) if (now - at > KNOWN_SUCCEEDED_TTL_MS) knownSucceeded.delete(id);
        if (knownSucceeded.size >= 2000) knownSucceeded.clear();
    }
    knownSucceeded.set(paymentIntentId, now);
}

export function isStripeTransferKnownSucceeded(paymentIntentId: string, now: number = Date.now()): boolean {
    const at = knownSucceeded.get(paymentIntentId);
    return at !== undefined && now - at <= KNOWN_SUCCEEDED_TTL_MS;
}

// ── Requests ──────────────────────────────────────────────────────────

export interface StripeBankTransferInput {
    orderCode: string;
    orderId: ID;
    /** The checkout channel: its Stripe key creates the intent and the webhook secret is picked by it. */
    channelId: ID;
    /** Vendure minor units. */
    amountMinor: number;
    currency: string;
    customer: {
        id?: ID | null;
        emailAddress: string;
        firstName?: string | null;
        lastName?: string | null;
        /**
         * The signed-in user, when the checkout is authenticated as this
         * (registered) customer. Only then is an existing Stripe customer
         * reused (one created for this customer and user), and only then may
         * that customer's cash balance pay for the order.
         */
        ownerUserId?: ID | null;
    };
    /** The payment method's `expiryDays` arg (pay-by date, as for static details). */
    expiryDays?: number | null;
    settings: StripeBankTransferSettings;
    now?: Date;
}

export interface StripeBankTransferRequestOptions {
    fetchImpl?: FetchLike;
    /** Total budget across all calls, ms. Default 15 s. */
    timeoutMs?: number;
}

/** The PaymentIntent create body (form-encoded by the client). */
export function buildBankTransferPaymentIntentParams(input: StripeBankTransferInput, customerId: string): Record<string, unknown> {
    const currency = input.currency.toUpperCase();
    const type = STRIPE_BANK_TRANSFER_TYPES[currency];
    if (!type) throw new StripeBankTransferError('unsupported_currency', `${currency} has no Stripe bank-transfer type`);
    const bankTransfer: Record<string, unknown> = { type };
    if (type === 'eu_bank_transfer') bankTransfer.eu_bank_transfer = { country: input.settings.euCountry };
    return {
        amount: toStripeMinorUnits(input.amountMinor, currency),
        currency: currency.toLowerCase(),
        customer: customerId,
        payment_method_types: ['customer_balance'],
        payment_method_data: { type: 'customer_balance' },
        payment_method_options: { customer_balance: { funding_type: 'bank_transfer', bank_transfer: bankTransfer } },
        confirm: true,
        description: `Order ${input.orderCode} (bank transfer)`,
        metadata: {
            [STRIPE_BANK_TRANSFER_METADATA.flag]: '1',
            [STRIPE_BANK_TRANSFER_METADATA.orderCode]: input.orderCode,
            [STRIPE_BANK_TRANSFER_METADATA.orderId]: String(input.orderId),
            [STRIPE_BANK_TRANSFER_METADATA.channelId]: String(input.channelId),
        },
    };
}

function clean(value: unknown): string | undefined {
    const v = typeof value === 'string' ? value.trim() : '';
    return v.length ? v : undefined;
}

function instructionsFor(settings: StripeBankTransferSettings, type: StripeBankTransferType, reference: string): string {
    if (settings.instructions) return settings.instructions.replace(/\{reference\}/g, reference);
    const timing = type === 'gb_bank_transfer'
        ? 'Faster Payments usually arrive within hours; BACS can take up to three working days.'
        : 'SEPA transfers usually arrive within one or two working days.';
    return `Please send the exact amount and quote the reference ${reference} so we can match your payment to this order. ${timing}`;
}

/**
 * Public details from a confirmed PaymentIntent's
 * `next_action.display_bank_transfer_instructions`. Throws
 * `missing_instructions` when Stripe gave no reference or no account to pay.
 */
export function mapStripeBankTransferInstructions(pi: StripeBankTransferIntentLike, input: StripeBankTransferInput): BankTransferPublicDetails {
    const currency = input.currency.toUpperCase();
    const type = STRIPE_BANK_TRANSFER_TYPES[currency];
    const instr = pi?.next_action?.type === 'display_bank_transfer_instructions' ? pi.next_action.display_bank_transfer_instructions : null;
    if (!type || !instr) throw new StripeBankTransferError('missing_instructions', `PaymentIntent ${pi?.id} has no bank-transfer instructions`);
    const reference = clean(instr.reference);
    if (!reference) throw new StripeBankTransferError('missing_instructions', `PaymentIntent ${pi.id} has no transfer reference`);
    const addresses = Array.isArray(instr.financial_addresses) ? instr.financial_addresses : [];
    const remaining = Number(instr.amount_remaining);
    const amountMinor = Number.isFinite(remaining) && remaining >= 0 ? fromStripeMinorUnits(remaining, currency) : input.amountMinor;
    // Same reference / amount / currency / pay-by logic as the static details.
    const base = buildBankTransferPublicDetails({
        orderCode: input.orderCode, amountMinor, currency, args: { expiryDays: input.expiryDays }, now: input.now,
    });
    const account: Partial<BankTransferPublicDetails> = {};
    if (type === 'gb_bank_transfer') {
        const sc = addresses.find(a => a?.type === 'sort_code' && a.sort_code)?.sort_code;
        const accountName = clean(sc?.account_holder_name);
        const accountNumber = clean(sc?.account_number);
        const sortCode = clean(sc?.sort_code);
        if (!accountName || !accountNumber || !sortCode) {
            throw new StripeBankTransferError('missing_instructions', `PaymentIntent ${pi.id} has no UK sort code and account number`);
        }
        account.accountName = accountName;
        account.sortCode = formatSortCode(sortCode);
        account.accountNumber = accountNumber;
    } else {
        const ib = addresses.find(a => a?.type === 'iban' && a.iban)?.iban;
        const accountName = clean(ib?.account_holder_name);
        const iban = clean(ib?.iban);
        if (!accountName || !iban) throw new StripeBankTransferError('missing_instructions', `PaymentIntent ${pi.id} has no IBAN`);
        account.accountName = accountName;
        account.iban = iban;
        const bic = clean(ib?.bic);
        if (bic) account.bic = bic;
    }
    const details: BankTransferPublicDetails = {
        method: BANK_TRANSFER_HANDLER_CODE,
        provider: 'stripe',
        ...account,
        reference,
        amountMinor: base.amountMinor,
        currency: base.currency,
        payBy: base.payBy,
        expiryDays: base.expiryDays,
        instructions: instructionsFor(input.settings, type, reference),
    };
    const hosted = clean(instr.hosted_instructions_url);
    if (hosted && /^https:\/\//i.test(hosted)) details.hostedInstructionsUrl = hosted;
    return details;
}

export type StripeBankTransferOutcome = {
    paymentIntentId: string;
    customerId: string;
    /** True when an existing Stripe customer (bound to the signed-in Vendure customer) was reused. */
    reusedCustomer: boolean;
    status: string;
    details: BankTransferPublicDetails;
} & (
    /** Waiting for the customer's transfer. */
    | { kind: 'awaiting' }
    /** Stripe applied the signed-in customer's own cash balance and that covered the whole amount. */
    | { kind: 'paid' }
);

function ownerOf(customer: StripeBankTransferInput['customer']): { customerId: string; userId: string } | null {
    if (customer?.id === undefined || customer?.id === null || customer?.ownerUserId === undefined || customer?.ownerUserId === null) return null;
    return { customerId: String(customer.id), userId: String(customer.ownerUserId) };
}

function isBoundCustomer(c: StripeCustomerLike | null | undefined, owner: { customerId: string; userId: string }): c is StripeCustomerLike & { id: string } {
    const m = c?.metadata || {};
    return typeof c?.id === 'string' && c.id.startsWith('cus_') && !c.deleted
        && m[STRIPE_BANK_TRANSFER_CUSTOMER_METADATA.customerId] === owner.customerId
        && m[STRIPE_BANK_TRANSFER_CUSTOMER_METADATA.userId] === owner.userId;
}

/**
 * The Stripe customer for this checkout. Signed in as the order's customer:
 * the Stripe customer created for that Vendure customer and user (found by
 * e-mail, then checked by metadata), or a new one bound to them. Anyone
 * else: a new Stripe customer for this order, which holds no balance. A
 * customer with the same e-mail that someone else created (a guest, the
 * Vendure StripePlugin, another integration) is never used.
 */
async function resolveStripeCustomer(
    apiKey: string, input: StripeBankTransferInput, email: string, call: (extra?: Partial<StripeRequestOptions>) => StripeRequestOptions,
): Promise<{ id: string; reused: boolean }> {
    const owner = ownerOf(input.customer);
    if (owner) {
        const found = await stripeRequest<{ data?: StripeCustomerLike[] }>(apiKey, 'GET', 'v1/customers', { email, limit: 100 }, call());
        const bound = (found?.data || []).find(c => isBoundCustomer(c, owner));
        if (bound) return { id: bound.id, reused: true };
    }
    const name = [clean(input.customer.firstName), clean(input.customer.lastName)].filter(Boolean).join(' ');
    const metadata: Record<string, string> = {};
    if (input.customer.id !== undefined && input.customer.id !== null) metadata[STRIPE_BANK_TRANSFER_CUSTOMER_METADATA.customerId] = String(input.customer.id);
    if (owner) metadata[STRIPE_BANK_TRANSFER_CUSTOMER_METADATA.userId] = owner.userId;
    else metadata[STRIPE_BANK_TRANSFER_CUSTOMER_METADATA.orderCode] = input.orderCode;
    const params: Record<string, unknown> = { email };
    if (name) params.name = name;
    params.metadata = metadata;
    const created = await stripeRequest<{ id?: string }>(
        apiKey, 'POST', 'v1/customers', params, call({ idempotencyKey: bankTransferCustomerIdempotencyKey(input.orderCode, params) }),
    );
    if (typeof created?.id !== 'string' || !created.id.startsWith('cus_')) throw new StripeBankTransferError('api_error', 'Stripe returned no customer id');
    return { id: created.id, reused: false };
}

/**
 * Find the Stripe customer (see `resolveStripeCustomer`), then create and
 * confirm a `customer_balance` PaymentIntent funded by bank transfer. One
 * budget of `timeoutMs` covers all calls. Throws `StripeBankTransferError` /
 * `StripeRequestError`; the handler turns any throw into the static details.
 * A throw whose create may still have reached Stripe carries `stray`, so the
 * handler can find that intent later and cancel it.
 */
export async function createStripeBankTransfer(
    apiKey: string, input: StripeBankTransferInput, opts: StripeBankTransferRequestOptions = {},
): Promise<StripeBankTransferOutcome> {
    const currency = input.currency.toUpperCase();
    if (!input.settings.currencies.includes(currency) || !STRIPE_BANK_TRANSFER_TYPES[currency]) {
        throw new StripeBankTransferError('unsupported_currency', `${currency} is not set up for Stripe bank transfers`);
    }
    const email = clean(input.customer?.emailAddress);
    if (!email) throw new StripeBankTransferError('no_customer', 'the order has no customer e-mail address');
    const budget = opts.timeoutMs ?? STRIPE_BANK_TRANSFER_TIMEOUT_MS;
    const deadline = Date.now() + budget;
    const call = (extra: Partial<StripeRequestOptions> = {}): StripeRequestOptions => {
        const left = deadline - Date.now();
        if (left <= 0) throw new StripeBankTransferError('timeout', `no answer from Stripe within ${Math.round(budget / 1000)} s`);
        return { fetchImpl: opts.fetchImpl, timeoutMs: left, ...extra };
    };
    const cancelQuietly = (id: string) => {
        // Fire and forget: checkout does not wait for it.
        void cancelPaymentIntent(apiKey, id, { cancellation_reason: 'abandoned' }, { fetchImpl: opts.fetchImpl, timeoutMs: 10_000 })
            .catch(() => undefined);
    };

    // 1. The customer: Stripe keeps one virtual account per customer, so a
    //    signed-in customer pays to the same account every time.
    const customer = await resolveStripeCustomer(apiKey, input, email, call);
    const owner = ownerOf(input.customer) !== null;

    // 2. The PaymentIntent, confirmed at once so Stripe hands back the instructions.
    const params = buildBankTransferPaymentIntentParams(input, customer.id);
    const amount = Number(params.amount);
    let replayed = false;
    const createOpts = call({
        idempotencyKey: bankTransferIdempotencyKey(input.orderCode, amount),
        onResponse: r => { replayed = r.replayed; },
    });
    const stray: StrayBankTransferIntent = { customerId: customer.id, orderCode: input.orderCode, sinceSec: Math.floor(Date.now() / 1000) - 120 };
    let pi: StripeBankTransferIntentLike | null;
    try {
        pi = await stripeRequest<StripeBankTransferIntentLike>(apiKey, 'POST', 'v1/payment_intents', params, createOpts);
    } catch (e) {
        if (definitelyNotCreated(e)) throw e;
        // No answer in time, a network failure or a Stripe 5xx: the intent may exist all the same.
        const reason = describeStripeFailure(e).startsWith('timeout') ? 'timeout' : 'api_error';
        throw new StripeBankTransferError(reason, describeStripeFailure(e).replace(/^\w+: /, ''), { stray });
    }
    if (!pi || !isPaymentIntentId(pi.id)) {
        throw new StripeBankTransferError('api_error', 'Stripe returned no PaymentIntent', { stray });
    }
    if (replayed) {
        // Stripe answered with its saved response to an earlier checkout of this
        // order and amount. The intent may have moved on since (cancelled, paid):
        // decide on its live state.
        const id = pi.id;
        try {
            pi = (await retrievePaymentIntent(apiKey, id, call())) as StripeBankTransferIntentLike;
        } catch (e) {
            throw new StripeBankTransferError('api_error', `could not check the replayed PaymentIntent ${id}: ${describeStripeFailure(e)}`, {
                stray: { ...stray, paymentIntentId: id },
            });
        }
        if (!pi || pi.id !== id) throw new StripeBankTransferError('api_error', `Stripe returned no PaymentIntent ${id}`, { stray: { ...stray, paymentIntentId: id } });
    }

    const funding = stripeTransferFunding(pi);
    const fromBalance = pi.status === 'succeeded' || (pi.status === 'requires_action' && funding.remaining !== null && funding.remaining < amount);
    if (fromBalance && !owner) {
        // Only a signed-in customer's own balance may pay for an order. A
        // checkout's own Stripe customer starts empty, so this is never expected.
        if (pi.status !== 'succeeded') cancelQuietly(pi.id);
        throw new StripeBankTransferError(
            'balance_applied',
            `Stripe applied a cash balance of customer ${customer.id} to PaymentIntent ${pi.id} (${pi.status}), but the checkout is not signed in as that customer`,
            { paymentIntentId: pi.id, intentStatus: pi.status },
        );
    }
    if (pi.status === 'succeeded') {
        const base = buildBankTransferPublicDetails({
            orderCode: input.orderCode, amountMinor: 0, currency, args: { expiryDays: input.expiryDays }, now: input.now,
        });
        return {
            kind: 'paid', paymentIntentId: pi.id, customerId: customer.id, reusedCustomer: customer.reused, status: pi.status,
            details: { ...base, provider: 'stripe', instructions: 'Paid in full from the balance you already hold with us. There is nothing more to transfer.' },
        };
    }
    try {
        if (pi.status !== 'requires_action') {
            throw new StripeBankTransferError('unexpected_status', `PaymentIntent ${pi.id} is ${pi.status}`, { paymentIntentId: pi.id, intentStatus: pi.status });
        }
        return {
            kind: 'awaiting', paymentIntentId: pi.id, customerId: customer.id, reusedCustomer: customer.reused, status: pi.status,
            details: mapStripeBankTransferInstructions(pi, input),
        };
    } catch (e) {
        // The static details will be shown instead: retire the intent so no
        // transfer can be matched to it.
        if (pi.status !== 'canceled') cancelQuietly(pi.id);
        throw e;
    }
}

export type StripeBankTransferCancelOutcome =
    /** `received`: Stripe minor units already applied to the intent; the cancel put them back in the customer's cash balance. */
    | { kind: 'canceled'; already: boolean; received: number }
    /** The customer has paid: the Vendure payment must be settled, not cancelled. */
    | { kind: 'succeeded' }
    /** `received` is what Stripe had applied when last seen, or null when it could not be asked. */
    | { kind: 'failed'; message: string; received: number | null };

/**
 * Best-effort cancel of the PaymentIntent behind an unpaid transfer. Looks at
 * the intent first, so a paid one is reported instead of cancelled and a part
 * payment is known. Never throws.
 */
export async function cancelStripeBankTransfer(
    apiKey: string, paymentIntentId: string, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<StripeBankTransferCancelOutcome> {
    const reqOpts = { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs ?? 10_000 };
    const before = (await retrievePaymentIntent(apiKey, paymentIntentId, reqOpts).catch(() => null)) as StripeBankTransferIntentLike | null;
    if (before?.status === 'succeeded') return { kind: 'succeeded' };
    if (before?.status === 'canceled') return { kind: 'canceled', already: true, received: 0 };
    const received = before ? stripeTransferFunding(before).received : null;
    try {
        await cancelPaymentIntent(apiKey, paymentIntentId, { cancellation_reason: 'abandoned' }, { ...reqOpts, idempotencyKey: cancelIdempotencyKey(paymentIntentId) });
        return { kind: 'canceled', already: false, received: received ?? 0 };
    } catch (e) {
        if (isUnexpectedStateError(e)) {
            const current = await retrievePaymentIntent(apiKey, paymentIntentId, reqOpts).catch(() => null);
            if (current?.status === 'canceled') return { kind: 'canceled', already: true, received: 0 };
            if (current?.status === 'succeeded') return { kind: 'succeeded' };
        }
        return { kind: 'failed', message: describeStripeFailure(e), received };
    }
}

/** The bank-transfer PaymentIntents of one Stripe customer for one order, created since `sinceSec`. Throws on Stripe errors. */
export async function findStrayBankTransferIntents(
    apiKey: string, stray: StrayBankTransferIntent, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<StripeBankTransferIntentLike[]> {
    const list = await stripeRequest<{ data?: StripeBankTransferIntentLike[] }>(
        apiKey, 'GET', 'v1/payment_intents', { customer: stray.customerId, created: { gte: stray.sinceSec }, limit: 20 },
        { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs ?? 15_000 },
    );
    return (list?.data || []).filter(pi => isPaymentIntentId(pi?.id) && parseBankTransferStripeMetadata(pi.metadata)?.orderCode === stray.orderCode);
}

/** A customer's available cash balance by lower-case currency, in Stripe minor units. Throws on Stripe errors. */
export async function retrieveCustomerCashBalance(
    apiKey: string, customerId: string, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<Record<string, number>> {
    const res = await stripeRequest<{ available?: Record<string, number> | null }>(
        apiKey, 'GET', `v1/customers/${encodeURIComponent(customerId)}/cash_balance`, {},
        { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs ?? 10_000 },
    );
    const out: Record<string, number> = {};
    for (const [cur, v] of Object.entries(res?.available || {})) if (Number.isFinite(Number(v))) out[cur.toLowerCase()] = Number(v);
    return out;
}

/** Test hook: forget which option warnings were logged and which intents were seen to succeed. */
export function _resetStripeBankTransferWarnings(): void {
    warned.clear();
    knownSucceeded.clear();
}
