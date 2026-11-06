import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Customer, Logger, Order, PaymentMethod } from '@vendure/core';

import { FakeConnection, flushAsync, installFakeStripe, stripeBankTransferIntent } from '../__tests__/fakes';
import { getStripeKeyForChannelId, resetMethodsCache } from '../stripe-hold/stripe-key';
import { buildBankTransferPublicDetails } from './bank-details';
import { setBankTransferRuntime } from './bank-transfer-runtime';
import { _resetBankTransferHandlerLog, bankTransferPaymentHandler } from './bank-transfer.handler';
import { _resetStripeBankTransferWarnings, noteStripeTransferSucceeded, normaliseStripeBankTransferOptions } from './stripe-bank-transfer';

/**
 * The handler through Vendure's own `PaymentMethodHandler` wrapper (args as
 * the `ConfigArg[]` Vendure stores), on the in-memory connection fake (the
 * channel's Stripe payment method, the order row for the lock, the customer
 * for the signed-in check, raw SQL routes), and a fake Stripe on the global fetch.
 */

const NOW = new Date('2026-11-06T10:00:00.000Z');
const stripeMethod = { id: 1, code: 'stripe', enabled: true, handler: { code: 'stripe', args: [{ name: 'apiKey', value: 'sk_test_bt' }] }, channels: [{ id: 2, code: 'elite' }] };

const args = [
    { name: 'accountName', value: 'HULO Ltd' },
    { name: 'accountNumber', value: '31138533' },
    { name: 'sortCode', value: '04-06-05' },
    { name: 'iban', value: 'GB33HULO04060531138533' },
    { name: 'bic', value: 'HULOGB2L' },
    { name: 'instructions', value: 'Please quote your order number as the payment reference.' },
    { name: 'expiryDays', value: '7' },
];
const staticDetails = () => buildBankTransferPublicDetails({
    orderCode: 'ORD1', amountMinor: 12999, currency: 'GBP', now: NOW,
    args: { accountName: 'HULO Ltd', accountNumber: '31138533', sortCode: '04-06-05', iban: 'GB33HULO04060531138533', bic: 'HULOGB2L', instructions: 'Please quote your order number as the payment reference.', expiryDays: 7 },
});

const shopCtx: any = { apiType: 'shop', channelId: 2, channel: { id: 2, code: 'elite' } };
const signedInCtx = (userId: any = 12): any => ({ ...shopCtx, activeUserId: userId });
const order = (over: Record<string, any> = {}): any => ({
    id: 10, code: 'ORD1', state: 'ArrangingPayment', currencyCode: 'GBP', totalWithTax: 12999,
    customer: { id: 7, emailAddress: 'jane@example.com', firstName: 'Jane', lastName: 'Doe' }, ...over,
});
const method: any = { code: 'bank-transfer' };
const boundCustomer = { id: 'cus_bound', metadata: { cg_vendure_customer_id: '7', cg_vendure_user_id: '12' } };

let sqlRoutes: Array<{ re: RegExp; rows: () => any[] }>;
let conn: FakeConnection;
let stripe: ReturnType<typeof installFakeStripe>;
let notify: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

function enable(opts: Record<string, any> = {}) {
    setBankTransferRuntime({ expiryDays: 7, reminderAfterDays: 3, stripe: normaliseStripeBankTransferOptions({ enabled: true, ...opts }), notifyOps: notify });
}
function setMethods(methods: any[]) {
    conn.repo(PaymentMethod).rows = methods;
    resetMethodsCache(conn as any);
}
const createPayment = (ctx: any, o: any = order()) => bankTransferPaymentHandler.createPayment(ctx, o, 12999, args as any, {}, method) as Promise<any>;
const settle = (ctx: any, payment: any, o: any = order({ state: 'PaymentAuthorized' })) => bankTransferPaymentHandler.settlePayment!(ctx, o, payment, args as any, method) as Promise<any>;
const cancel = (ctx: any, payment: any, o: any = order({ state: 'PaymentAuthorized' })) => bankTransferPaymentHandler.cancelPayment!(ctx, o, payment, args as any, method) as Promise<any>;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    _resetStripeBankTransferWarnings();
    _resetBankTransferHandlerLog();
    sqlRoutes = [];
    conn = new FakeConnection({ query: (sql: string) => { const hit = sqlRoutes.find(r => r.re.test(sql.replace(/\s+/g, ' '))); return hit ? hit.rows() : []; } });
    setMethods([stripeMethod]);
    conn.repo(Order).rows = [{ id: 10, state: 'ArrangingPayment' }];
    bankTransferPaymentHandler.init({ get: () => conn } as any);
    notify = vi.fn(async () => undefined);
    warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    info = vi.spyOn(Logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(Logger, 'verbose').mockImplementation(() => undefined);
    setBankTransferRuntime({ expiryDays: 7, reminderAfterDays: 3, notifyOps: notify }); // Stripe off: the default
    stripe = installFakeStripe(call => {
        if (call.method === 'GET' && call.path === '/v1/customers') return { body: { data: [boundCustomer] } };
        if (call.method === 'POST' && call.path === '/v1/customers') return { body: { id: 'cus_new' } };
        if (call.method === 'POST' && call.path === '/v1/payment_intents') return { body: stripeBankTransferIntent({ customer: call.form.customer }) };
        if (call.method === 'GET' && call.path === '/v1/payment_intents/pi_bt123') return { body: stripeBankTransferIntent() };
        if (call.path.endsWith('/cancel')) return { body: { id: 'pi_bt123', status: 'canceled' } };
        return { status: 404, body: { error: { message: 'no route' } } };
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('Stripe bank transfers off (the default)', () => {
    it('returns exactly what 0.2.9 returned and never calls Stripe or the database', async () => {
        const r = await createPayment(shopCtx);
        expect(r).toEqual({
            method: 'bank-transfer',
            amount: 12999,
            state: 'Authorized',
            transactionId: 'ORD1',
            metadata: { public: staticDetails() },
        });
        expect(r.metadata.public).toEqual({
            method: 'bank-transfer', reference: 'ORD1', amountMinor: 12999, currency: 'GBP', payBy: '2026-11-13T23:59:59.999Z', expiryDays: 7,
            accountName: 'HULO Ltd', accountNumber: '31138533', sortCode: '04-06-05', iban: 'GB33HULO04060531138533', bic: 'HULOGB2L',
            instructions: 'Please quote your order number as the payment reference.',
        });
        expect(await settle(shopCtx, { id: 41, metadata: r.metadata })).toEqual({ success: true });
        expect(await cancel(shopCtx, { id: 41, metadata: r.metadata })).toEqual({ success: true });
        expect(stripe.calls).toHaveLength(0);
        expect(conn.queries).toHaveLength(0);
        expect(conn.repo(Order).createQueryBuilder).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it('stays off when the option is present but not enabled', async () => {
        setBankTransferRuntime({ stripe: normaliseStripeBankTransferOptions({ enabled: false }) });
        const r = await createPayment(shopCtx);
        expect(r.metadata).toEqual({ public: staticDetails() });
        expect(stripe.calls).toHaveLength(0);
    });
});

describe('createPayment through Stripe', () => {
    beforeEach(() => enable());

    it('places a guest\'s order Authorized with its own Stripe customer, the account in metadata.public and the intent kept private', async () => {
        const r = await createPayment(shopCtx);
        expect(r).toMatchObject({ method: 'bank-transfer', amount: 12999, state: 'Authorized', transactionId: 'ORD1' });
        expect(r.metadata.public).toEqual({
            method: 'bank-transfer',
            provider: 'stripe',
            accountName: 'HULO GLOBAL LIMITED',
            sortCode: '20-00-00',
            accountNumber: '98765432',
            reference: 'RF7K2M9Q4XWZ',
            amountMinor: 12999,
            currency: 'GBP',
            payBy: '2026-11-13T23:59:59.999Z',
            expiryDays: 7,
            instructions: expect.stringContaining('quote the reference RF7K2M9Q4XWZ'),
            hostedInstructionsUrl: 'https://payments.stripe.com/bank_transfers/instructions/test_abc',
        });
        // The method's own IBAN/BIC must not sit next to Stripe's account (a payer would mix them up).
        expect(r.metadata.public.iban).toBeUndefined();
        expect(r.metadata.public.bic).toBeUndefined();
        expect(r.metadata).toMatchObject({ paymentIntentId: 'pi_bt123', stripeCustomerId: 'cus_new', stripeChannelId: '2', stripeStatus: 'requires_action' });
        expect(JSON.stringify(r.metadata.public)).not.toMatch(/pi_bt123|cus_new/);
        // A guest is never looked up by e-mail: the customer is created for this order.
        expect(stripe.calls.map(c => `${c.method} ${c.path}`)).toEqual(['POST /v1/customers', 'POST /v1/payment_intents']);
        expect(stripe.calls[0].form['metadata[cg_order_code]']).toBe('ORD1');
        // The checkout channel's key and channel id are used, and the order row was locked first.
        expect(stripe.calls[0].headers.Authorization).toBe('Bearer sk_test_bt');
        expect(stripe.to(/payment_intents/)[0].form['metadata[cg_channel_id]']).toBe('2');
        expect(conn.repo(Order).createQueryBuilder).toHaveBeenCalledTimes(1);
        expect(notify).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledWith('Stripe bank transfers on channel 2 use the Stripe payment method "stripe"', 'CheckoutGuard');
    });

    it('uses the channel\'s own Stripe method on the default channel, while holds keep their usual pick', async () => {
        // Vendure assigns every method to the default channel too: the other channel's Stripe method comes first in row order.
        setMethods([
            { id: 1, code: 'stripe-licensedock', enabled: true, handler: { code: 'stripe', args: [{ name: 'apiKey', value: 'sk_test_other' }] }, channels: [{ id: 1, code: '__default_channel__' }, { id: 2, code: 'licensedock' }] },
            { id: 5, code: 'stripe', enabled: true, handler: { code: 'stripe', args: [{ name: 'apiKey', value: 'sk_test_own' }] }, channels: [{ id: 1, code: '__default_channel__' }] },
        ]);
        await createPayment({ apiType: 'shop', channelId: 1, channel: { id: 1, code: '__default_channel__' } });
        expect(stripe.calls[0].headers.Authorization).toBe('Bearer sk_test_own');
        expect(await getStripeKeyForChannelId(conn as any, 1)).toBe('sk_test_other'); // unchanged for holds and reconciliation
        expect(await getStripeKeyForChannelId(conn as any, 2, { preferOwnMethod: true })).toBe('sk_test_other');
    });

    it('a guest using the e-mail of a customer with a Stripe balance can never be paid from it', async () => {
        // Whatever Stripe does, a guest's order is not settled from a balance: here Stripe (wrongly) paid the intent.
        stripe.respond(call => call.path === '/v1/customers'
            ? { body: { id: 'cus_new' } }
            : { body: stripeBankTransferIntent({ status: 'succeeded', amount_received: 12999, next_action: null }) });
        const r = await createPayment(shopCtx);
        expect(r).toEqual({ method: 'bank-transfer', amount: 12999, state: 'Authorized', transactionId: 'ORD1', metadata: { public: staticDetails() } });
        expect(stripe.to(/^GET \/v1\/customers/)).toHaveLength(0);
        expect(notify.mock.calls[0][0]).toMatchObject({ event: 'bank.stripe_fallback', orderCode: 'ORD1', paymentIntentId: 'pi_bt123' });
        expect(notify.mock.calls[0][0].text).toMatch(/balance_applied: .*refund it from the Stripe dashboard/);
    });

    it('a signed-in customer reuses their own Stripe customer, and their own balance can pay the order at once', async () => {
        conn.repo(Customer).rows = [{ id: 7, user: { id: 12 } }];
        stripe.respond(call => {
            if (call.method === 'GET' && call.path === '/v1/customers') return { body: { data: [{ id: 'cus_plugin', metadata: {} }, boundCustomer] } };
            return { body: stripeBankTransferIntent({ customer: call.form.customer, status: 'succeeded', amount_received: 12999, next_action: null }) };
        });
        const r = await createPayment(signedInCtx());
        expect(stripe.calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /v1/customers', 'POST /v1/payment_intents']);
        expect(stripe.to(/payment_intents/)[0].form.customer).toBe('cus_bound');
        expect(r.state).toBe('Settled');
        expect(r.metadata).toMatchObject({
            paymentIntentId: 'pi_bt123', stripeCustomerId: 'cus_bound', stripeStatus: 'succeeded', settledBy: 'stripe', public: { provider: 'stripe', amountMinor: 0 },
        });
    });

    it('a session signed in as somebody else is treated as a guest', async () => {
        conn.repo(Customer).rows = [{ id: 7, user: { id: 12 } }];
        await createPayment(signedInCtx(99));
        expect(stripe.calls.map(c => `${c.method} ${c.path}`)).toEqual(['POST /v1/customers', 'POST /v1/payment_intents']);
        // The order's customer already carries its user: no lookup needed.
        stripe.calls.length = 0;
        await createPayment(signedInCtx(12), order({ customer: { ...order().customer, user: { id: 12 } } }));
        expect(stripe.calls[0].path).toBe('/v1/customers');
        expect(stripe.calls[0].method).toBe('GET');
    });

    it('refuses a second submit of the same checkout that lost the race, without calling Stripe', async () => {
        conn.repo(Order).rows = [{ id: 10, state: 'PaymentAuthorized' }]; // the other request committed first
        const r = await createPayment(shopCtx);
        expect(r).toEqual({ method: 'bank-transfer', amount: 12999, state: 'Error', errorMessage: expect.stringMatching(/placed by another request/), metadata: {} });
        expect(stripe.calls).toHaveLength(0);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Second bank-transfer payment request for order ORD1 refused/), 'CheckoutGuard');
    });

    it('keeps the method\'s own details for a currency that is not a Stripe one', async () => {
        const r = await createPayment(shopCtx, order({ currencyCode: 'USD' }));
        expect(r.metadata).toEqual({ public: { ...staticDetails(), currency: 'USD' } });
        expect(stripe.calls).toHaveLength(0);
        expect(conn.repo(Order).createQueryBuilder).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });
});

describe('createPayment falls back to the static details on any Stripe failure', () => {
    beforeEach(() => enable());

    async function expectFallback(reason: RegExp) {
        const r = await createPayment(shopCtx);
        expect(r).toEqual({ method: 'bank-transfer', amount: 12999, state: 'Authorized', transactionId: 'ORD1', metadata: { public: staticDetails() } });
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Stripe bank transfer for order ORD1 failed/), 'CheckoutGuard');
        expect(warn.mock.calls.at(-1)![0]).toMatch(reason);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({ event: 'bank.stripe_fallback', orderCode: 'ORD1', amountMinor: 12999, currency: 'GBP', channelId: 2 });
        expect(notify.mock.calls[0][0].text).toMatch(reason);
        return r;
    }

    it('no Stripe key on the channel', async () => {
        setMethods([{ ...stripeMethod, channels: [{ id: 1, code: '__default_channel__' }] }]);
        await expectFallback(/no_key/);
        expect(stripe.calls).toHaveLength(0);
    });

    it('an order without a customer e-mail', async () => {
        const r = await createPayment(shopCtx, order({ customer: undefined }));
        expect(r.metadata).toEqual({ public: staticDetails() });
        expect(notify.mock.calls[0][0].text).toMatch(/no_customer/);
    });

    it('a Stripe API error', async () => {
        stripe.respond(call => call.path === '/v1/customers'
            ? { body: { id: 'cus_new' } }
            : { status: 400, body: { error: { type: 'invalid_request_error', code: 'payment_method_unactivated', message: 'customer_balance is not activated' } } });
        await expectFallback(/payment_method_unactivated/);
    });

    it('a Stripe outage on the customer create', async () => {
        stripe.respond(() => ({ status: 503, body: {} }));
        await expectFallback(/api_error: HTTP 503/);
    });

    it('a timeout (15 s budget)', async () => {
        vi.useRealTimers(); // re-install with timers faked too (a second useFakeTimers call is a no-op)
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(NOW);
        stripe.respond(() => 'hang');
        const pending = createPayment(shopCtx);
        await vi.advanceTimersByTimeAsync(15_001);
        const r: any = await pending;
        expect(r.metadata).toEqual({ public: staticDetails() });
        expect(notify.mock.calls[0][0].text).toMatch(/timeout/);
    });

    it('instructions missing from Stripe\'s answer (the stray intent is cancelled)', async () => {
        stripe.respond(call => {
            if (call.path === '/v1/customers') return { body: { id: 'cus_new' } };
            if (call.path.endsWith('/cancel')) return { body: { id: 'pi_bt123', status: 'canceled' } };
            return { body: stripeBankTransferIntent({ next_action: null }) };
        });
        await expectFallback(/missing_instructions/);
        await vi.waitFor(() => expect(stripe.to(/\/v1\/payment_intents\/pi_bt123\/cancel$/)).toHaveLength(1));
    });

    it('an unexpected throw (never escapes into checkout)', async () => {
        stripe.respond(() => { throw new Error('socket hang up'); });
        await expectFallback(/socket hang up/);
    });
});

describe('a PaymentIntent create whose answer was lost', () => {
    const MIN = 60_000;
    let listed: any[];
    let listFails = 0;

    beforeEach(() => {
        enable();
        vi.useRealTimers();
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(NOW);
        listed = [stripeBankTransferIntent({ id: 'pi_stray1' })];
        listFails = 0;
        stripe.respond(call => {
            if (call.path === '/v1/customers') return { body: { id: 'cus_new' } };
            if (call.method === 'POST' && call.path === '/v1/payment_intents') return { status: 500, body: { error: { type: 'api_error', message: 'boom' } } };
            if (call.method === 'GET' && call.path === '/v1/payment_intents') {
                return listFails-- > 0 ? { status: 503, body: {} } : { body: { data: listed } };
            }
            if (call.method === 'GET') return { body: listed.find(p => call.path.endsWith(p.id)) ?? stripeBankTransferIntent() };
            if (call.path.endsWith('/cancel')) return { body: { id: call.path.split('/')[3], status: 'canceled' } };
            return { status: 404, body: {} };
        });
    });

    async function tick(ms: number) {
        await vi.advanceTimersByTimeAsync(ms);
        for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(0);
    }

    it('falls back at once, then finds the intent on the customer and cancels it', async () => {
        const r = await createPayment(shopCtx);
        expect(r.metadata).toEqual({ public: staticDetails() });
        expect(stripe.to(/GET \/v1\/payment_intents$/)).toHaveLength(0); // nothing more during checkout
        await tick(30_000);
        const [list] = stripe.to(/GET \/v1\/payment_intents$/);
        expect(list.query).toEqual({ customer: 'cus_new', 'created[gte]': String(Math.floor(NOW.getTime() / 1000) - 120), limit: '20' });
        expect(stripe.to(/POST \/v1\/payment_intents\/pi_stray1\/cancel$/)).toHaveLength(1);
        expect(info).toHaveBeenCalledWith('Cancelled stray Stripe PaymentIntent pi_stray1 for order ORD1', 'CheckoutGuard');
    });

    it('leaves an intent alone that a payment of the order carries', async () => {
        sqlRoutes.push({ re: /FROM payment p JOIN `order` o ON o\.id = p\.`orderId` WHERE o\.code = \?/, rows: () => [{ metadata: JSON.stringify({ paymentIntentId: 'pi_stray1' }) }] });
        await createPayment(shopCtx);
        await tick(30_000);
        expect(stripe.to(/cancel$/)).toHaveLength(0);
    });

    it('alerts a stray intent Stripe has already paid', async () => {
        listed = [stripeBankTransferIntent({ id: 'pi_stray1', status: 'succeeded', next_action: null })];
        await createPayment(shopCtx);
        await tick(30_000);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'bank.stripe_unsettled', orderCode: 'ORD1', paymentIntentId: 'pi_stray1' }));
    });

    it('looks again later when the intent is not listed yet, and asks for a hand when Stripe cannot be asked at all', async () => {
        listed = [];
        await createPayment(shopCtx);
        await tick(30_000);
        expect(stripe.to(/GET \/v1\/payment_intents$/)).toHaveLength(1);
        listed = [stripeBankTransferIntent({ id: 'pi_late' })];
        await tick(5 * MIN);
        expect(stripe.to(/GET \/v1\/payment_intents$/)).toHaveLength(2);
        expect(stripe.to(/POST \/v1\/payment_intents\/pi_late\/cancel$/)).toHaveLength(1);

        notify.mockClear();
        listFails = 2;
        await createPayment(shopCtx);
        await tick(30_000);
        await tick(5 * MIN);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'bank.stripe_cancel_failed', orderCode: 'ORD1' }));
        expect(notify.mock.calls.at(-1)![0].text).toMatch(/cancel any incomplete payment of customer cus_new whose metadata has cg_order_code ORD1/);
    });
});

describe('settlePayment of a Stripe-backed transfer', () => {
    const stripePayment = (over: Record<string, any> = {}): any => ({
        id: 41, amount: 12999, state: 'Authorized',
        metadata: { public: { method: 'bank-transfer', provider: 'stripe' }, paymentIntentId: 'pi_bt123', stripeChannelId: '2', ...over },
    });
    const adminCtx: any = { apiType: 'admin', channelId: 1, channel: { id: 1, code: '__default_channel__' } };

    it('Stripe\'s own settlement (the webhook or sweep saw the intent succeed) needs no second look', async () => {
        noteStripeTransferSucceeded('pi_bt123');
        expect(await settle(adminCtx, stripePayment())).toEqual({
            success: true, metadata: { stripeStatus: 'succeeded', settledBy: 'stripe', stripeSettledAt: NOW.toISOString() },
        });
        expect(stripe.calls).toHaveLength(0);
    });

    it('by hand: the unpaid PaymentIntent is cancelled so later transfers cannot complete it unnoticed', async () => {
        const r = await settle(adminCtx, stripePayment());
        expect(r).toEqual({
            success: true,
            metadata: { settledBy: 'hand', stripeSettledByHandAt: NOW.toISOString(), stripeStatus: 'canceled', stripeCancelledAt: NOW.toISOString() },
        });
        expect(stripe.calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /v1/payment_intents/pi_bt123', 'POST /v1/payment_intents/pi_bt123/cancel']);
        expect(stripe.calls[0].headers.Authorization).toBe('Bearer sk_test_bt'); // the key of the channel that created it
        expect(notify).not.toHaveBeenCalled();
    });

    it('by hand while part had arrived through Stripe: asks for that part to be refunded', async () => {
        stripe.respond(call => call.method === 'GET'
            ? { body: stripeBankTransferIntent({ instructions: { amount_remaining: 5000 } }) }
            : { body: { id: 'pi_bt123', status: 'canceled' } });
        await settle(adminCtx, stripePayment());
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({ event: 'bank.stripe_partially_funded', orderCode: 'ORD1', amountMinor: 7999, paymentIntentId: 'pi_bt123' });
        expect(notify.mock.calls[0][0].text).toMatch(/marked received by hand while £79\.99 of £129\.99 had already arrived/);
    });

    it('by hand, but Stripe has the money: counts as Stripe\'s settlement and cancels nothing', async () => {
        stripe.respond(() => ({ body: stripeBankTransferIntent({ status: 'succeeded', next_action: null }) }));
        expect(await settle(adminCtx, stripePayment())).toMatchObject({ success: true, metadata: { settledBy: 'stripe', stripeStatus: 'succeeded' } });
        expect(stripe.to(/cancel$/)).toHaveLength(0);
    });

    it('by hand when Stripe cannot be reached: settles, and asks for the intent to be cancelled in the dashboard', async () => {
        stripe.respond(() => ({ status: 500, body: { error: { type: 'api_error', message: 'boom' } } }));
        const r = await settle(adminCtx, stripePayment());
        expect(r).toEqual({ success: true, metadata: { settledBy: 'hand', stripeSettledByHandAt: NOW.toISOString(), stripeCancelError: 'api_error: api_error: boom' } });
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'bank.stripe_cancel_failed', orderCode: 'ORD1', paymentIntentId: 'pi_bt123' }));
        expect(notify.mock.calls[0][0].text).toMatch(/marked received by hand/);
    });

    it('refuses to settle a duplicate of a payment already settled for the same transfer', async () => {
        sqlRoutes.push({ re: /SELECT id, state, metadata FROM payment WHERE `orderId` = \? AND id <> \?/, rows: () => [{ id: 43, state: 'Settled', metadata: { paymentIntentId: 'pi_bt123' } }] });
        expect(await settle(adminCtx, stripePayment())).toEqual({
            success: false, state: 'Authorized', errorMessage: expect.stringMatching(/payment 43 has already been settled for this Stripe transfer/),
        });
        expect(conn.ran(/id <> \?/)[0].params).toEqual([10, 41]);
        expect(stripe.calls).toHaveLength(0);
    });
});

describe('cancelPayment of a Stripe-backed transfer', () => {
    const stripePayment = (over: Record<string, any> = {}): any => ({
        id: 41, amount: 12999, state: 'Authorized',
        metadata: { public: { method: 'bank-transfer', provider: 'stripe' }, paymentIntentId: 'pi_bt123', stripeChannelId: '2', ...over },
    });
    // The Vendure admin may act in the default channel; the intent's own channel picks the key.
    const adminCtx: any = { apiType: 'admin', channelId: 1, channel: { id: 1, code: '__default_channel__' } };

    it('cancels the PaymentIntent at Stripe with the key of the channel that created it', async () => {
        const r = await cancel(adminCtx, stripePayment());
        expect(r).toEqual({ success: true, metadata: { stripeStatus: 'canceled', stripeCancelledAt: NOW.toISOString() } });
        const [call] = stripe.to(/cancel$/);
        expect(call.path).toBe('/v1/payment_intents/pi_bt123/cancel');
        expect(call.headers.Authorization).toBe('Bearer sk_test_bt');
        expect(notify).not.toHaveBeenCalled();
    });

    it('asks for a part payment to be refunded, whichever way the transfer is cancelled', async () => {
        stripe.respond(call => call.method === 'GET'
            ? { body: stripeBankTransferIntent({ instructions: { amount_remaining: 5000 } }) }
            : { body: { id: 'pi_bt123', status: 'canceled' } });
        expect((await cancel(adminCtx, stripePayment())).success).toBe(true);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({ event: 'bank.stripe_partially_funded', orderCode: 'ORD1', amountMinor: 7999, paymentIntentId: 'pi_bt123' });
        expect(notify.mock.calls[0][0].text).toMatch(/cancelled with £79\.99 of £129\.99 already paid through Stripe .*refund it from the Stripe dashboard/);
    });

    it('refuses to cancel a transfer Stripe says the customer has paid', async () => {
        stripe.respond(() => ({ body: stripeBankTransferIntent({ status: 'succeeded', next_action: null }) }));
        const r = await cancel(adminCtx, stripePayment());
        expect(r).toEqual({ success: false, state: 'Authorized', errorMessage: expect.stringMatching(/already paid this transfer through Stripe/) });
        expect(stripe.to(/cancel$/)).toHaveLength(0);
    });

    it('still cancels the Vendure payment when Stripe cannot be reached, and raises an alert', async () => {
        stripe.respond(() => ({ status: 500, body: { error: { type: 'api_error', message: 'boom' } } }));
        const r = await cancel(adminCtx, stripePayment());
        expect(r).toEqual({ success: true, metadata: { stripeCancelError: 'api_error: api_error: boom' } });
        await flushAsync();
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'bank.stripe_cancel_failed', orderCode: 'ORD1', paymentIntentId: 'pi_bt123' }));
    });

    it('reports an intent it has no key for', async () => {
        setMethods([]);
        const r = await cancel(adminCtx, stripePayment());
        expect(r).toEqual({ success: true, metadata: { stripeCancelError: 'no Stripe secret key on channel 2' } });
        expect(stripe.calls).toHaveLength(0);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'bank.stripe_cancel_failed' }));
    });

    it('cancels a duplicate payment locally and leaves the PaymentIntent to the payment it belongs to', async () => {
        sqlRoutes.push({ re: /id <> \?/, rows: () => [{ id: 43, state: 'Settled', metadata: JSON.stringify({ paymentIntentId: 'pi_bt123' }) }] });
        expect(await cancel(adminCtx, stripePayment())).toEqual({ success: true, metadata: { stripeDuplicateOf: '43' } });
        expect(stripe.calls).toHaveLength(0);
        expect(notify).not.toHaveBeenCalled();
    });
});
