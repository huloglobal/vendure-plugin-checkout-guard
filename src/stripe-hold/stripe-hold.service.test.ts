import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Order, Payment, PaymentMethod } from '@vendure/core';
import { FakeConnection, errorResult, fakeChannelService, fakeOrderService, fakeRequestContextService, flushAsync } from '../__tests__/fakes';
import { configureStripeHold } from './runtime';
import { resetMethodsCache } from './stripe-key';
import { StripeHoldService } from './stripe-hold.service';

vi.mock('./stripe-api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./stripe-api')>()),
    retrievePaymentIntent: vi.fn(),
}));
import { retrievePaymentIntent } from './stripe-api';
const retrieve = retrievePaymentIntent as unknown as ReturnType<typeof vi.fn>;

const channels = [
    { id: 1, token: 'tok-default', code: '__default_channel__' },
    { id: 2, token: 'tok-elite', code: 'elite' },
];
const stripeMethod = { id: 1, code: 'stripe-elite', enabled: true, handler: { code: 'stripe', args: [{ name: 'apiKey', value: 'sk_test_abc' }] }, channels: [{ id: 2 }] };
const holdMethod = { id: 2, code: 'stripe-hold', enabled: true, handler: { code: 'stripe-hold', args: [] }, channels: [{ id: 2 }] };

function intent(over: Record<string, any> = {}) {
    return {
        id: 'pi_abc123', status: 'requires_capture', amount: 12345, amount_capturable: 12345, currency: 'gbp', capture_method: 'manual',
        metadata: { orderCode: 'ORD1', orderId: '10', channelToken: 'tok-elite', languageCode: 'en' },
        ...over,
    };
}
function event(type: string, pi: any) { return { type, data: { object: pi } }; }

let conn: FakeConnection;
let orders: ReturnType<typeof fakeOrderService>;
let svc: StripeHoldService;
let notify: ReturnType<typeof vi.fn>;
let record: ReturnType<typeof vi.fn>;
let options: Record<string, any>;
let premium = true;

function makeOrder(over: Record<string, any> = {}): Order {
    const { totalWithTax = 12345, ...rest } = over;
    const o = new Order({ id: 10, code: 'ORD1', state: 'ArrangingPayment', currencyCode: 'GBP', payments: [], channels: [channels[1]] as any, ...rest } as any);
    // `totalWithTax` is a computed getter on the entity; pin it for the test.
    Object.defineProperty(o, 'totalWithTax', { value: totalWithTax, configurable: true });
    return o;
}

beforeEach(() => {
    conn = new FakeConnection();
    conn.repo(PaymentMethod).rows = [stripeMethod, holdMethod];
    orders = fakeOrderService(conn);
    svc = new StripeHoldService(conn as any, orders as any, fakeChannelService(channels) as any, fakeRequestContextService(channels) as any);
    notify = vi.fn(async () => undefined);
    record = vi.fn(async () => undefined);
    options = { safetyCaptureDays: 6 };
    premium = true;
    configureStripeHold({ getOptions: () => options, hasPremiumAccess: () => premium, notifyOps: notify, recordPaymentEvent: record });
    (StripeHoldService as any).lastLockedAlertAt = 0;
    retrieve.mockReset();
    retrieve.mockImplementation(async (_key: string, id: string) => intent({ id }));
    resetMethodsCache(conn as any);
    // Default: the order exists and addPaymentToOrder returns it with the new Authorized payment attached.
    orders.findOneByCode.mockImplementation(async () => makeOrder());
    orders.addPaymentToOrder.mockImplementation(async (_ctx: any, _orderId: any, input: any) => {
        const payment = { id: 77, transactionId: input.metadata.paymentIntentId, state: 'Authorized', method: input.method, amount: 12345 };
        conn.log.push('addPayment');
        return makeOrder({ payments: [payment] });
    });
});
afterEach(() => vi.restoreAllMocks());

describe('handleEvent — amount_capturable_updated', () => {
    it('ignores events without a PaymentIntent or Vendure metadata', async () => {
        expect((await svc.handleEvent({ type: 'payment_intent.amount_capturable_updated', data: { object: { id: 'ch_1' } } })).message).toMatch(/ignored/);
        expect((await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent({ metadata: {} })))).message).toMatch(/no Vendure metadata/);
        expect(orders.addPaymentToOrder).not.toHaveBeenCalled();
    });

    it('records a hold on the free tier too (0.4.0: the hold list is free)', async () => {
        premium = false;
        const r = await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent()));
        expect(r).toEqual({ status: 200, message: 'Hold pi_abc123 recorded on order ORD1' });
        expect(orders.addPaymentToOrder).toHaveBeenCalledTimes(1);
        await flushAsync();
        expect(notify.mock.calls[0][0]).toMatchObject({ event: 'hold.authorized', orderCode: 'ORD1' });
    });

    it('leaves a below-threshold hold for review on the free tier (auto-capture is premium)', async () => {
        premium = false;
        options = { safetyCaptureDays: 6, autoCaptureBelowMinor: 20000 };
        const r = await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent()));
        expect(r.status).toBe(200);
        expect(orders.settlePayment).not.toHaveBeenCalled();
        expect(conn.log).toEqual(['tx:start', 'addPayment', 'tx:end']);
    });

    it('records a new hold: live intent checked before the transaction, Authorized payment added, ops alerted after commit', async () => {
        const r = await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent()));
        expect(r).toEqual({ status: 200, message: 'Hold pi_abc123 recorded on order ORD1' });
        expect(retrieve).toHaveBeenCalledWith('sk_test_abc', 'pi_abc123', expect.anything());
        expect(conn.log).toEqual(['tx:start', 'addPayment', 'tx:end']);
        expect(orders.addPaymentToOrder).toHaveBeenCalledWith(expect.anything(), 10, {
            method: 'stripe-hold',
            metadata: { paymentIntentId: 'pi_abc123', amountCapturable: 12345, stripeStatus: 'requires_capture', latestCharge: undefined },
        });
        expect(orders.transitionToState).not.toHaveBeenCalled();
        expect(orders.settlePayment).not.toHaveBeenCalled();
        await flushAsync();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({ event: 'hold.authorized', orderCode: 'ORD1', amountMinor: 12345, currency: 'GBP', channelCode: 'elite' });
    });

    it('moves an order that is still AddingItems to ArrangingPayment first, and reports a failed transition', async () => {
        orders.findOneByCode.mockImplementation(async () => makeOrder({ state: 'AddingItems' }));
        const ok = await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent()));
        expect(ok.status).toBe(200);
        expect(orders.transitionToState).toHaveBeenCalledWith(expect.anything(), 10, 'ArrangingPayment');
        expect(orders.addPaymentToOrder).toHaveBeenCalledTimes(1);

        orders.transitionToState.mockImplementation(async () => errorResult('cannot transition from AddingItems', 'ORDER_STATE_TRANSITION_ERROR'));
        const failed = await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent({ id: 'pi_other1' })));
        expect(failed).toEqual({ status: 200, message: 'Order state transition failed' });
        expect(orders.addPaymentToOrder).toHaveBeenCalledTimes(1);
        await flushAsync();
        expect(notify.mock.calls.map(c => c[0].event)).toContain('hold.webhook_error');
    });

    it('de-duplicates a redelivered event without calling Stripe or adding a payment', async () => {
        conn.repo(Payment).rows = [{ id: 5, transactionId: 'pi_abc123', state: 'Authorized', method: 'stripe-hold' }];
        const r = await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent()));
        expect(r.message).toBe('Hold pi_abc123 already recorded as payment 5 (Authorized)');
        expect(retrieve).not.toHaveBeenCalled();
        expect(orders.addPaymentToOrder).not.toHaveBeenCalled();
        expect(conn.withTransaction).not.toHaveBeenCalled();
    });

    it('also de-duplicates inside the transaction when a racing delivery committed first', async () => {
        const repo = conn.repo(Payment);
        repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 6, transactionId: 'pi_abc123', state: 'Authorized' });
        const r = await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent()));
        expect(r.message).toBe('Hold pi_abc123 already recorded as payment 6 (Authorized)');
        expect(retrieve).toHaveBeenCalledTimes(1);
        expect(orders.addPaymentToOrder).not.toHaveBeenCalled();
    });

    it('shares one in-flight handler between concurrent deliveries of the same intent', async () => {
        const [a, b] = await Promise.all([
            svc.handleEvent(event('payment_intent.amount_capturable_updated', intent())),
            svc.handleEvent(event('payment_intent.amount_capturable_updated', intent())),
        ]);
        expect(a).toEqual(b);
        expect(orders.addPaymentToOrder).toHaveBeenCalledTimes(1);
    });

    it('rejects an unknown channel token and a missing order with a 200 and an ops alert', async () => {
        const wrong = await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent({ metadata: { orderCode: 'ORD1', orderId: '10', channelToken: 'tok-nope' } })));
        expect(wrong).toEqual({ status: 200, message: 'Unknown channel token' });
        expect(retrieve).not.toHaveBeenCalled();

        orders.findOneByCode.mockImplementation(async () => null);
        const missing = await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent()));
        expect(missing).toEqual({ status: 200, message: 'Order not found' });
        expect(orders.addPaymentToOrder).not.toHaveBeenCalled();
        await flushAsync();
        expect(notify.mock.calls.map(c => c[0].text)).toEqual([
            'Stripe hold pi_abc123 for order ORD1: unknown channel token',
            'Stripe hold pi_abc123: order ORD1 not found',
        ]);
    });

    it('reports a channel without a stripe-hold method', async () => {
        conn.repo(PaymentMethod).rows = [stripeMethod];
        resetMethodsCache(conn as any);
        const r = await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent()));
        expect(r).toEqual({ status: 200, message: 'No stripe-hold payment method on channel' });
    });

    it('auto-captures a below-threshold hold AFTER the recording transaction commits', async () => {
        options = { safetyCaptureDays: 6, autoCaptureBelowMinor: 20000 };
        const r = await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent()));
        expect(r.status).toBe(200);
        expect(conn.log).toEqual(['tx:start', 'addPayment', 'tx:end', 'tx:start', 'settle:77', 'tx:end']);
        await flushAsync();
        expect(notify.mock.calls.map(c => c[0].event)).toEqual(['hold.authorized', 'hold.auto_captured']);
    });

    it('keeps the hold and raises capture_failed when the post-commit auto-capture fails', async () => {
        options = { safetyCaptureDays: 6, autoCaptureBelowMinor: 20000 };
        orders.settlePayment.mockImplementation(async () => errorResult('card declined', 'SETTLE_PAYMENT_ERROR', { paymentErrorMessage: 'stripe-hold: card_declined' }));
        const r = await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent()));
        expect(r).toEqual({ status: 200, message: 'Hold pi_abc123 recorded on order ORD1' });
        await flushAsync();
        const failed = notify.mock.calls.map(c => c[0]).find(e => e.event === 'hold.capture_failed');
        expect(failed?.text).toBe('Auto-capture failed for ORD1: stripe-hold: card_declined');
    });

    it('does not auto-capture at or above the threshold', async () => {
        options = { safetyCaptureDays: 6, autoCaptureBelowMinor: 12345 };
        await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent()));
        expect(orders.settlePayment).not.toHaveBeenCalled();
    });

    it('records and settles a hold whose live intent has already been captured at Stripe', async () => {
        retrieve.mockImplementation(async (_k: string, id: string) => intent({ id, status: 'succeeded', amount_capturable: 0, amount_received: 12345, latest_charge: 'ch_9' }));
        const r = await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent()));
        expect(r.status).toBe(200);
        expect(orders.addPaymentToOrder.mock.calls[0][2].metadata).toEqual({ paymentIntentId: 'pi_abc123', amountCapturable: 12345, stripeStatus: 'succeeded', latestCharge: 'ch_9' });
        expect(conn.log).toEqual(['tx:start', 'addPayment', 'tx:end', 'tx:start', 'settle:77', 'tx:end']);
        await flushAsync();
        expect(notify.mock.calls.map(c => c[0].event)).toEqual(['hold.captured']);
    });

    it('skips a hold whose live intent was cancelled at Stripe, recording an expiry event instead', async () => {
        retrieve.mockImplementation(async (_k: string, id: string) => intent({ id, status: 'canceled', amount_capturable: 0, cancellation_reason: 'automatic' }));
        const r = await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent()));
        expect(r).toEqual({ status: 200, message: 'PaymentIntent pi_abc123 is canceled at Stripe, no hold created' });
        expect(conn.withTransaction).not.toHaveBeenCalled();
        expect(orders.addPaymentToOrder).not.toHaveBeenCalled();
        expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'hold_expired', providerRef: 'pi_abc123', orderCode: 'ORD1', channelId: 2, amountMinor: 12345, currency: 'GBP' }));
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'hold.expired', paymentIntentId: 'pi_abc123' }));
    });

    it('treats any other live status as nothing to hold', async () => {
        retrieve.mockImplementation(async (_k: string, id: string) => intent({ id, status: 'processing' }));
        const r = await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent()));
        expect(r.message).toBe('PaymentIntent pi_abc123 is processing at Stripe, nothing to hold');
        expect(orders.addPaymentToOrder).not.toHaveBeenCalled();
    });

    it('falls back to the signed event payload when Stripe cannot be reached or the channel has no key', async () => {
        retrieve.mockRejectedValueOnce(new Error('ECONNRESET'));
        expect((await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent()))).status).toBe(200);
        expect(orders.addPaymentToOrder).toHaveBeenCalledTimes(1);

        conn.repo(PaymentMethod).rows = [holdMethod];
        resetMethodsCache(conn as any);
        expect((await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent({ id: 'pi_nokey1' })))).status).toBe(200);
        expect(retrieve).toHaveBeenCalledTimes(1);
        expect(orders.addPaymentToOrder).toHaveBeenCalledTimes(2);
    });

    it('answers 500 (Stripe retries) when the transaction throws', async () => {
        orders.findOneByCode.mockImplementation(async () => { throw new Error('deadlock'); });
        const r = await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent()));
        expect(r).toEqual({ status: 500, message: 'Internal error — retry' });
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'hold.webhook_error', text: expect.stringContaining('deadlock') }));
    });

    it('ignores intents the event already reports as not capturable', async () => {
        const r = await svc.handleEvent(event('payment_intent.amount_capturable_updated', intent({ status: 'succeeded', amount_capturable: 0 })));
        expect(r.message).toBe('PaymentIntent pi_abc123 is succeeded, nothing to hold');
        expect(retrieve).not.toHaveBeenCalled();
    });
});

describe('handleEvent — other events', () => {
    it('records a payment failure with the decline code', async () => {
        const r = await svc.handleEvent(event('payment_intent.payment_failed', intent({ status: 'requires_payment_method', last_payment_error: { message: 'Your card was declined.', decline_code: 'insufficient_funds', code: 'card_declined' } })));
        expect(r.status).toBe(200);
        expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed', code: 'insufficient_funds', orderCode: 'ORD1', channelId: 2, amountMinor: 12345, currency: 'GBP' }));
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'payment.failed', text: 'Card payment failed for order ORD1: Your card was declined. (insufficient_funds)' }));
    });

    it('ignores unrelated event types', async () => {
        expect((await svc.handleEvent(event('charge.refunded', intent()))).message).toBe('Event charge.refunded ignored');
    });
});

describe('capture / cancel', () => {
    const ctx: any = { apiType: 'admin', channelId: 2, channel: channels[1] };
    const hold = () => ({ id: 77, transactionId: 'pi_abc123', state: 'Authorized', method: 'stripe-hold', amount: 12345, createdAt: new Date(), metadata: {}, order: { id: 10, code: 'ORD1', currencyCode: 'GBP', state: 'PaymentAuthorized', channels: [channels[1]] } });

    beforeEach(() => { conn.repo(Payment).rows = [hold()]; });

    it('maps lookup failures', async () => {
        expect(await svc.capture(ctx, 99)).toEqual({ ok: false, paymentId: 99, error: 'payment_not_found' });
        conn.repo(Payment).rows = [{ ...hold(), method: 'stripe' }];
        expect((await svc.capture(ctx, 77)).error).toBe('not_a_stripe_hold');
        conn.repo(Payment).rows = [hold()];
        expect((await svc.capture({ ...ctx, channelId: 3 }, 77)).error).toBe('payment_not_found');
        expect((await svc.capture({ ...ctx, channelId: undefined }, 77)).ok).toBe(true);
    });

    it('refuses a payment that is not Authorized', async () => {
        conn.repo(Payment).rows = [{ ...hold(), state: 'Settled' }];
        expect(await svc.capture(ctx, 77)).toEqual({ ok: false, paymentId: 77, state: 'Settled', error: 'payment_is_settled' });
        expect(await svc.cancel(ctx, 77)).toEqual({ ok: false, paymentId: 77, state: 'Settled', error: 'payment_is_settled' });
        expect(orders.settlePayment).not.toHaveBeenCalled();
    });

    it('settles under the row lock and alerts with the caller', async () => {
        const r = await svc.capture(ctx, 77, 'cron');
        expect(r).toEqual({ ok: true, paymentId: 77, state: 'Settled' });
        expect(conn.log).toEqual(['tx:start', 'settle:77', 'tx:end']);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'hold.safety_captured', amountMinor: 12345, currency: 'GBP' }));
        await svc.capture(ctx, 77, 'admin');
        expect(notify.mock.calls[1][0].event).toBe('hold.captured');
    });

    it('re-reads the state under the lock: already Settled is success for cron/stripe, an error for an admin', async () => {
        conn.repo(Payment).lockOverride = () => ({ ...hold(), state: 'Settled' });
        expect(await svc.capture(ctx, 77, 'cron')).toEqual({ ok: true, paymentId: 77, state: 'Settled' });
        expect(await svc.capture(ctx, 77, 'stripe')).toEqual({ ok: true, paymentId: 77, state: 'Settled' });
        expect(await svc.capture(ctx, 77, 'admin')).toEqual({ ok: false, paymentId: 77, state: 'Settled', error: 'payment_is_settled' });
        conn.repo(Payment).lockOverride = () => null;
        expect(await svc.capture(ctx, 77, 'cron')).toEqual({ ok: false, paymentId: 77, state: 'missing', error: 'payment_is_missing' });
        expect(orders.settlePayment).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it('surfaces a settle error, recording an expiry when Stripe says the authorisation lapsed', async () => {
        orders.settlePayment.mockImplementation(async () => errorResult('settle failed', 'SETTLE_PAYMENT_ERROR', { paymentErrorMessage: 'stripe-hold: authorisation was cancelled at Stripe (expired or released)' }));
        const r = await svc.capture(ctx, 77, 'cron');
        expect(r).toMatchObject({ ok: false, paymentId: 77, state: 'Authorized' });
        expect(r.error).toMatch(/cancelled at Stripe/);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'hold.capture_failed' }));
        expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'hold_expired', providerRef: 'pi_abc123' }));

        orders.settlePayment.mockImplementation(async () => { throw new Error('socket hang up'); });
        expect(await svc.capture(ctx, 77)).toEqual({ ok: false, paymentId: 77, state: 'Authorized', error: 'socket hang up' });
    });

    it('cancels under the row lock; an expired release is silent, a stale Cancelled is success for non-admins', async () => {
        expect(await svc.cancel(ctx, 77, 'expired')).toEqual({ ok: true, paymentId: 77, state: 'Cancelled' });
        expect(conn.log).toEqual(['tx:start', 'cancelPayment:77', 'tx:end']);
        expect(notify).not.toHaveBeenCalled();
        expect(await svc.cancel(ctx, 77, 'admin')).toEqual({ ok: true, paymentId: 77, state: 'Cancelled' });
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'hold.cancelled' }));

        conn.repo(Payment).lockOverride = () => ({ ...hold(), state: 'Cancelled' });
        expect(await svc.cancel(ctx, 77, 'stripe')).toEqual({ ok: true, paymentId: 77, state: 'Cancelled' });
        expect(await svc.cancel(ctx, 77, 'admin')).toEqual({ ok: false, paymentId: 77, state: 'Cancelled', error: 'payment_is_cancelled' });

        conn.repo(Payment).lockOverride = undefined;
        orders.cancelPayment.mockImplementation(async () => errorResult('nope', 'CANCEL_PAYMENT_ERROR', { paymentErrorMessage: 'stripe-hold: already captured' }));
        expect(await svc.cancel(ctx, 77)).toEqual({ ok: false, paymentId: 77, state: 'Authorized', error: 'stripe-hold: already captured' });
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'hold.cancel_failed' }));
    });

    it('settles a manual-capture intent captured outside Vendure, and releases a cancelled one', async () => {
        const ok = await svc.handleEvent(event('payment_intent.succeeded', intent({ status: 'succeeded', capture_method: 'manual' })));
        expect(ok.message).toBe('Hold pi_abc123 settled after external capture');
        expect(orders.settlePayment).toHaveBeenCalledTimes(1);
        expect((await svc.handleEvent(event('payment_intent.succeeded', intent({ status: 'succeeded', capture_method: 'automatic' })))).message).toMatch(/Stripe plugin/);

        const expired = await svc.handleEvent(event('payment_intent.canceled', intent({ status: 'canceled', cancellation_reason: 'automatic' })));
        expect(expired.message).toBe('Hold pi_abc123 cancelled locally');
        expect(orders.cancelPayment).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'hold_expired' }));
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'hold.expired' }));

        conn.repo(Payment).rows = [];
        expect((await svc.handleEvent(event('payment_intent.canceled', intent({ status: 'canceled' })))).message).toBe('No local hold for this intent');
    });
});

describe('listHolds / safetyCapture', () => {
    const ctx: any = { apiType: 'admin', channelId: 2, channel: channels[1] };
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    const row = (id: number, createdAt: Date, over: Record<string, any> = {}) => ({
        id, transactionId: `pi_${id}`, state: 'Authorized', method: 'stripe-hold', amount: 1000, createdAt, metadata: {},
        order: { id: 100 + id, code: `ORD${id}`, currencyCode: 'GBP', state: 'PaymentAuthorized', channels: [channels[1]], customer: { emailAddress: 'a@b.c' } }, ...over,
    });

    it('lists Authorized holds in the ctx channel with the due flag', async () => {
        conn.repo(Payment).rows = [row(1, days(7)), row(2, days(1)), row(3, days(7), { order: { id: 9, code: 'X', channels: [channels[0]] } })];
        const all = await svc.listHolds(ctx);
        expect(all.map(h => [h.orderCode, h.due])).toEqual([['ORD1', true], ['ORD2', false]]);
        expect(all[0]).toMatchObject({ paymentId: 1, paymentIntentId: 'pi_1', channelCode: 'elite', customerEmail: 'a@b.c', amount: 1000, currencyCode: 'GBP' });
        expect((await svc.listHolds(ctx, { includeDue: true })).map(h => h.paymentId)).toEqual([1]);
        expect((await svc.listHolds(ctx, { includeDue: false })).map(h => h.paymentId)).toEqual([2]);
    });

    it('captures due holds, releases those on cancelled orders and leaves the rest', async () => {
        conn.repo(Payment).rows = [row(1, days(7)), row(2, days(1)), row(3, days(8), { order: { id: 103, code: 'ORD3', currencyCode: 'GBP', state: 'Cancelled', channels: [channels[1]] } })];
        const report = await svc.safetyCapture();
        expect(report).toEqual({ scanned: 3, captured: 1, failed: 0, skipped: 2 });
        expect(orders.settlePayment).toHaveBeenCalledWith(expect.anything(), 1);
        expect(orders.cancelPayment).toHaveBeenCalledWith(expect.anything(), 3);
        expect(notify.mock.calls.map(c => c[0].event)).toEqual(['hold.safety_captured']);
        premium = false;
        expect(await svc.safetyCapture()).toEqual({ scanned: 0, captured: 0, failed: 0, skipped: 0 });
    });
});

describe('HULO Payments holds (premium, opt-in)', () => {
    const ctx: any = { apiType: 'admin', channelId: 2, channel: channels[1] };
    const huloMethod = { id: 3, code: 'hulo-card', enabled: true, handler: { code: 'hulo-stripe', args: [] }, channels: [{ id: 2 }] };
    const huloBank = { id: 4, code: 'hulo-bank', enabled: true, handler: { code: 'hulo-bank-transfer', args: [] }, channels: [{ id: 2 }] };
    const order = (id: number) => ({ id: 200 + id, code: `H${id}`, currencyCode: 'GBP', state: 'PaymentAuthorized', channels: [channels[1]] });
    let sources = { huloPayments: false, huloPaymentsSafetyCapture: false };

    beforeEach(() => {
        sources = { huloPayments: false, huloPaymentsSafetyCapture: false };
        configureStripeHold({ holdSources: () => sources });
        conn.repo(PaymentMethod).rows = [stripeMethod, holdMethod, huloMethod, huloBank];
        resetMethodsCache(conn as any);
        const old = new Date(Date.now() - 8 * 86_400_000);
        conn.repo(Payment).rows = [
            { id: 1, transactionId: 'pi_h1', state: 'Authorized', method: 'stripe-hold', amount: 100, createdAt: old, metadata: {}, order: order(1) },
            { id: 2, transactionId: 'pi_h2', state: 'Authorized', method: 'hulo-card', amount: 200, createdAt: old, metadata: { capture: 'manual' }, order: order(2) },
            { id: 3, transactionId: 'pi_h3', state: 'Authorized', method: 'hulo-card', amount: 300, createdAt: old, metadata: { capture: 'automatic' }, order: order(3) },
            { id: 4, transactionId: 'bt_4', state: 'Authorized', method: 'hulo-bank', amount: 400, createdAt: old, metadata: {}, order: order(4) },
        ] as any;
    });
    afterEach(() => configureStripeHold({ holdSources: () => ({ huloPayments: false, huloPaymentsSafetyCapture: false }) }));

    it('lists only Stripe holds by default (ELITE keeps 0.3.x behaviour)', async () => {
        expect((await svc.listHolds(ctx)).map(h => h.paymentId)).toEqual([1]);
        expect((await svc.capture(ctx, 2)).error).toBe('not_a_stripe_hold');
    });

    it('adds manual-capture HULO Payments payments when switched on with premium, and captures them', async () => {
        sources = { huloPayments: true, huloPaymentsSafetyCapture: false };
        const list = await svc.listHolds(ctx);
        expect(list.map(h => [h.paymentId, h.source])).toEqual([[1, 'stripe-hold'], [2, 'hulo-payments']]);
        const r = await svc.capture(ctx, 2);
        expect(r.ok).toBe(true);
        expect(orders.settlePayment).toHaveBeenCalledWith(expect.anything(), 2);
        premium = false;
        expect((await svc.listHolds(ctx)).map(h => h.paymentId)).toEqual([1]);
    });

    it('safety-captures HULO Payments holds only with huloPaymentsSafetyCapture', async () => {
        sources = { huloPayments: true, huloPaymentsSafetyCapture: false };
        expect((await svc.safetyCapture()).scanned).toBe(1);
        sources = { huloPayments: true, huloPaymentsSafetyCapture: true };
        const report = await svc.safetyCapture();
        expect(report.scanned).toBe(2);
    });
});

describe('webhook declines carry the order client IP (opt-in)', () => {
    it('records the stored IP with the failed event', async () => {
        configureStripeHold({ orderClientIp: async code => (code === 'ORD1' ? '198.51.100.44' : null) });
        await svc.handleEvent(event('payment_intent.payment_failed', intent({ status: 'requires_payment_method', last_payment_error: { message: 'declined', code: 'card_declined' } })));
        expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed', ip: '198.51.100.44' }));
        configureStripeHold({ orderClientIp: async () => null });
    });
});

