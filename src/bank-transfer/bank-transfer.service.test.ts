import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Order, Payment } from '@vendure/core';
import { FakeConnection, errorResult, fakeOrderService, fakeRequestContextService } from '../__tests__/fakes';
import { setBankTransferRuntime } from './bank-transfer-runtime';
import { BankTransferExpiredEvent, BankTransferReminderEvent } from './bank-transfer.events';
import { BankTransferService } from './bank-transfer.service';

const channels = [
    { id: 1, token: 'tok-default', code: '__default_channel__' },
    { id: 2, token: 'tok-elite', code: 'elite' },
];
const days = (n: number) => new Date(Date.now() - n * 86_400_000);

/** Routes raw SQL to canned results; tests swap entries per case. */
let sqlRoutes: Array<{ re: RegExp; rows: () => any[] }>;
let conn: FakeConnection;
let orders: ReturnType<typeof fakeOrderService>;
let eventBus: { publish: ReturnType<typeof vi.fn> };
let svc: BankTransferService;
let premium = true;

function bankPayment(over: Record<string, any> = {}): any {
    return {
        id: 41, method: 'bank-transfer', state: 'Authorized', amount: 5000, createdAt: days(1),
        metadata: { public: { method: 'bank-transfer', payBy: days(-6).toISOString(), currency: 'GBP', accountName: 'HULO Ltd' } },
        order: { id: 10, code: 'ORD1', state: 'PaymentAuthorized', currencyCode: 'GBP', channels: [channels[0], channels[1]] },
        ...over,
    };
}

beforeEach(() => {
    sqlRoutes = [
        { re: /SELECT code, handler FROM payment_method/, rows: () => [{ code: 'bacs', handler: JSON.stringify({ code: 'bank-transfer', args: [] }) }, { code: 'stripe', handler: JSON.stringify({ code: 'stripe' }) }] },
    ];
    conn = new FakeConnection({ query: (sql: string) => { const hit = sqlRoutes.find(r => r.re.test(sql.replace(/\s+/g, ' '))); return hit ? hit.rows() : []; } });
    orders = fakeOrderService(conn);
    orders.findOne.mockImplementation(async (_ctx: any, id: any) => ({ id, state: 'PaymentSettled', code: 'ORD1' }));
    eventBus = { publish: vi.fn(async () => undefined) };
    premium = true;
    setBankTransferRuntime({ expiryDays: 7, reminderAfterDays: 3, hasPremiumAccess: () => premium });
    svc = new BankTransferService(conn as any, orders as any, fakeRequestContextService(channels) as any, eventBus as any);
});

describe('method codes', () => {
    it('resolves every method whose handler is bank-transfer, plus the handler code itself', async () => {
        expect(await svc.bankTransferMethodCodes()).toEqual(['bacs', 'bank-transfer']);
        expect(await svc.bankTransferMethodCodes()).toEqual(['bacs', 'bank-transfer']);
        expect(conn.ran(/FROM payment_method/)).toHaveLength(1); // cached
    });
});

describe('list', () => {
    const listRow = (over: Record<string, any> = {}) => ({
        paymentId: 41, paymentState: 'Authorized', amountMinor: 5000, createdAt: days(1), paymentUpdatedAt: days(1),
        metadata: JSON.stringify({ public: { method: 'bank-transfer', payBy: days(-6).toISOString(), currency: 'GBP', accountName: 'HULO Ltd' } }),
        orderId: 10, orderCode: 'ORD1', orderState: 'PaymentAuthorized', currency: 'GBP', customerEmail: 'a@b.c',
        channelId: 1, channelCode: '__default_channel__', reminderSentAt: null, expiredAt: null, settledAt: null, cancelledAt: null, trackedPayBy: null, ...over,
    });

    it('scopes to the admin channel and keeps the non-default channel row per payment', async () => {
        sqlRoutes.push({ re: /FROM payment p JOIN `order` o/, rows: () => [listRow(), listRow({ channelId: 2, channelCode: 'elite' }), listRow({ paymentId: 42, orderId: 11, orderCode: 'ORD2', paymentState: 'Settled', settledAt: days(0) })] });
        const rows = await svc.list('awaiting', 30, 50, { channelId: 2, channel: { code: 'elite' } } as any);
        const q = conn.ran(/FROM payment p JOIN `order` o/)[0];
        expect(q.sql).toContain('EXISTS (SELECT 1 FROM order_channels_channel x WHERE x.`orderId` = o.id AND x.`channelId` = ?)');
        expect(q.sql).toContain("p.state = 'Authorized'");
        expect(q.sql).toContain('LIMIT 200');
        expect(q.params).toEqual(['bacs', 'bank-transfer', 2, 30]);
        expect(rows.map(r => [r.paymentId, r.channelCode])).toEqual([[41, 'elite'], [42, '__default_channel__']]);
        expect(rows[0]).toMatchObject({ orderCode: 'ORD1', amountMinor: 5000, currency: 'GBP', accountName: 'HULO Ltd', customerEmail: 'a@b.c', daysLeft: 6, settledAt: null });
        expect(rows[1].settledAt).not.toBeNull();
    });

    it('does not scope the default channel and applies the status filters', async () => {
        sqlRoutes.push({ re: /FROM payment p JOIN `order` o/, rows: () => [] });
        await svc.list('expired', 5000, 9999, { channelId: 1, channel: { code: '__default_channel__' } } as any);
        const q = conn.ran(/FROM payment p JOIN `order` o/)[0];
        expect(q.sql).not.toContain('order_channels_channel x');
        expect(q.sql).toContain("p.state = 'Cancelled' AND t.expiredAt IS NOT NULL");
        expect(q.sql).toContain('LIMIT 4000');
        expect(q.params).toEqual(['bacs', 'bank-transfer', 3650]);
        await svc.list('all');
        expect(conn.ran(/FROM payment p JOIN `order` o/)[1].sql).not.toContain('p.state =');
    });

    it('counts awaiting transfers', async () => {
        sqlRoutes.push({ re: /SELECT COUNT\(\*\) AS n FROM payment p/, rows: () => [{ n: '3' }] });
        expect(await svc.countAwaiting()).toBe(3);
    });
});

describe('markReceived', () => {
    it('rejects payments that are not bank transfers or not visible in the admin channel', async () => {
        expect(await svc.markReceived(41)).toEqual({ ok: false, error: 'not_a_bank_transfer_payment' });
        conn.repo(Payment).rows = [bankPayment({ method: 'stripe' })];
        expect(await svc.markReceived(41)).toEqual({ ok: false, error: 'not_a_bank_transfer_payment' });
        conn.repo(Payment).rows = [bankPayment({ order: { ...bankPayment().order, channels: [channels[1]] } })];
        expect(await svc.markReceived(41, { channelId: 3, channel: { code: 'other' } } as any)).toEqual({ ok: false, error: 'not_a_bank_transfer_payment' });
        expect(orders.settlePayment).not.toHaveBeenCalled();
    });

    it('refuses a payment that is no longer Authorized', async () => {
        conn.repo(Payment).rows = [bankPayment({ state: 'Cancelled' })];
        expect(await svc.markReceived(41)).toEqual({ ok: false, error: 'payment_not_authorized:Cancelled', paymentState: 'Cancelled', orderState: 'PaymentAuthorized' });
    });

    it('re-reads the state under the row lock and refuses a stale payment', async () => {
        conn.repo(Payment).rows = [bankPayment()];
        conn.repo(Payment).lockOverride = () => bankPayment({ state: 'Cancelled' });
        expect(await svc.markReceived(41)).toEqual({ ok: false, error: 'payment_not_authorized:Cancelled', paymentState: 'Cancelled', orderState: 'PaymentAuthorized' });
        expect(orders.settlePayment).not.toHaveBeenCalled();
        expect(conn.ran(/settledAt = NOW\(\)/)).toHaveLength(0);
    });

    it('settles inside the transaction in the order channel and tracks the settlement', async () => {
        conn.repo(Payment).rows = [bankPayment()];
        const r = await svc.markReceived(41, { channelId: 2, channel: { code: 'elite' } } as any);
        expect(r).toEqual({ ok: true, paymentState: 'Settled', orderState: 'PaymentSettled' });
        expect(conn.log).toEqual(['tx:start', 'settle:41', 'tx:end']);
        expect(orders.settlePayment.mock.calls[0][0]).toMatchObject({ apiType: 'admin', channelId: 2 });
        const tracked = conn.ran(/INSERT IGNORE INTO checkout_guard_bank_transfer/);
        expect(tracked).toHaveLength(1);
        expect(tracked[0].params.slice(0, 6)).toEqual([41, 10, 'ORD1', 2, 5000, 'GBP']);
        expect(conn.ran(/SET settledAt = NOW\(\) WHERE paymentId = \?/)[0].params).toEqual([41]);
    });

    it('surfaces a settle error result', async () => {
        conn.repo(Payment).rows = [bankPayment()];
        orders.settlePayment.mockImplementation(async () => errorResult('cannot settle', 'SETTLE_PAYMENT_ERROR'));
        expect(await svc.markReceived(41)).toEqual({ ok: false, error: 'cannot settle', paymentState: 'Authorized', orderState: 'PaymentAuthorized' });
    });
});

describe('cancelByAdmin', () => {
    it('cancels the payment under the lock, then the order, and tracks it', async () => {
        conn.repo(Payment).rows = [bankPayment()];
        const r = await svc.cancelByAdmin(41, 'Customer changed their mind');
        expect(r).toEqual({ ok: true, paymentState: 'Cancelled', orderState: 'Cancelled' });
        expect(conn.log).toEqual(['tx:start', 'cancelPayment:41', 'tx:end', 'cancelOrder:10']);
        expect(orders.cancelOrder.mock.calls[0][1]).toEqual({ orderId: 10, reason: 'Customer changed their mind' });
        expect(conn.ran(/SET cancelledAt = NOW\(\) WHERE paymentId = \?/)[0].params).toEqual([41]);
        expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('maps non-Authorized, stale-under-lock and order-cancel failures', async () => {
        conn.repo(Payment).rows = [bankPayment({ state: 'Settled' })];
        expect(await svc.cancelByAdmin(41)).toEqual({ ok: false, error: 'payment_not_authorized:Settled', paymentState: 'Settled', orderState: 'PaymentAuthorized' });

        conn.repo(Payment).rows = [bankPayment()];
        conn.repo(Payment).lockOverride = () => bankPayment({ state: 'Settled' });
        expect(await svc.cancelByAdmin(41)).toEqual({ ok: false, error: 'payment_not_authorized:Settled', paymentState: 'Settled', orderState: 'PaymentAuthorized' });
        expect(orders.cancelPayment).not.toHaveBeenCalled();

        conn.repo(Payment).lockOverride = undefined;
        orders.cancelOrder.mockImplementation(async () => errorResult('order has fulfilments', 'CANCEL_ACTIVE_ORDER_ERROR'));
        expect(await svc.cancelByAdmin(41)).toEqual({ ok: false, error: 'cancel_order_failed: order has fulfilments', paymentState: 'Cancelled', orderState: 'PaymentAuthorized' });
        expect(conn.ran(/SET cancelledAt = NOW\(\) WHERE paymentId/)).toHaveLength(0);
    });
});

describe('sweep', () => {
    const candidate = (paymentId: number, createdAt: Date, payBy: Date | null, reminderSentAt: Date | null = null) => ({
        paymentId, orderId: 100 + paymentId, orderCode: `ORD${paymentId}`, channelId: 2, paymentCreatedAt: createdAt, amount: 5000,
        metadata: JSON.stringify({ public: { method: 'bank-transfer', payBy: payBy ? payBy.toISOString() : undefined, currency: 'GBP' } }), reminderSentAt,
    });

    it('is a logged no-op while premium is locked', async () => {
        premium = false;
        expect(await svc.sweep()).toEqual({ scanned: 0, expired: 0, reminded: 0, repaired: 0, skipped: 'locked' });
        expect(conn.queries).toHaveLength(0);
    });

    it('expires past-due transfers, reminds mid-window ones, skips those no longer Authorized', async () => {
        sqlRoutes.push({ re: /SET reminderSentAt = NOW\(\)/, rows: () => ({ affectedRows: 1 }) as any });
        sqlRoutes.push({ re: /MAX\(occ\.`channelId`\)/, rows: () => [
            candidate(51, days(10), days(3)),            // expired 3 days ago
            candidate(52, days(4), days(-3)),            // reminder due (3 days elapsed), not expired
            candidate(53, days(1), days(-6)),            // nothing due
            candidate(54, days(10), days(3)),            // expired but the payment was settled meanwhile
        ] });
        const rows: Record<number, any> = {
            51: bankPayment({ id: 51, order: { id: 151, code: 'ORD51', state: 'PaymentAuthorized', currencyCode: 'GBP', channels: [channels[1]] } }),
            52: bankPayment({ id: 52, createdAt: days(4), order: { id: 152, code: 'ORD52', state: 'PaymentAuthorized', currencyCode: 'GBP', channels: [channels[1]] } }),
            54: bankPayment({ id: 54, state: 'Settled', order: { id: 154, code: 'ORD54', state: 'PaymentSettled', currencyCode: 'GBP', channels: [channels[1]] } }),
        };
        conn.repo(Payment).rows = Object.values(rows);
        const r = await svc.sweep();
        expect(r).toEqual({ scanned: 4, expired: 1, reminded: 1, repaired: 0, skipped: null });
        // expiredAt is recorded BEFORE the cancellation so a half-finished pass is recognisable.
        const expiredIdx = conn.queries.findIndex(q => /SET expiredAt = NOW\(\) WHERE paymentId = \? AND expiredAt IS NULL/.test(q.sql));
        expect(expiredIdx).toBeGreaterThan(-1);
        expect(conn.log).toEqual(['tx:start', 'cancelPayment:51', 'tx:end', 'cancelOrder:151']);
        expect(conn.ran(/SET expiredAt = NOW\(\), cancelledAt = NOW\(\)/)[0].params).toEqual([51]);
        expect(conn.ran(/SET reminderSentAt = NOW\(\)/)[0].params).toEqual([52]);
        expect(eventBus.publish).toHaveBeenCalledTimes(2);
        const [expired, reminded] = eventBus.publish.mock.calls.map(c => c[0]);
        expect(expired).toBeInstanceOf(BankTransferExpiredEvent);
        expect(expired.payment.id).toBe(51);
        expect(reminded).toBeInstanceOf(BankTransferReminderEvent);
        expect(reminded.payment.id).toBe(52);
        expect(orders.cancelOrder).toHaveBeenCalledTimes(1);
    });

    it('publishes a reminder only when this run claimed it (no duplicate e-mail from an overlapping sweep)', async () => {
        sqlRoutes.push({ re: /SET reminderSentAt = NOW\(\)/, rows: () => ({ affectedRows: 0 }) as any });
        sqlRoutes.push({ re: /MAX\(occ\.`channelId`\)/, rows: () => [candidate(52, days(4), days(-3))] });
        conn.repo(Payment).rows = [bankPayment({ id: 52, createdAt: days(4), order: { id: 152, code: 'ORD52', state: 'PaymentAuthorized', currencyCode: 'GBP', channels: [channels[1]] } })];
        const r = await svc.sweep();
        expect(r.reminded).toBe(0);
        expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('leaves a transfer alone when the cancellation fails, and finishes stranded orders on the next pass', async () => {
        sqlRoutes.push({ re: /MAX\(occ\.`channelId`\)/, rows: () => [candidate(51, days(10), days(3))] });
        sqlRoutes.push({ re: /AND EXISTS \(SELECT 1 FROM checkout_guard_bank_transfer t WHERE t\.orderId = o\.id AND t\.expiredAt IS NOT NULL\)/, rows: () => [{ orderId: 151, orderCode: 'ORD51' }] });
        conn.repo(Payment).rows = [bankPayment({ id: 51, order: { id: 151, code: 'ORD51', state: 'PaymentAuthorized', currencyCode: 'GBP', channels: [channels[1]] } })];
        conn.repo(Order).rows = [{ id: 151, code: 'ORD51', state: 'PaymentAuthorized', channels: [channels[1]] }];
        orders.cancelOrder.mockImplementationOnce(async () => errorResult('boom', 'ORDER_STATE_TRANSITION_ERROR'));
        const r = await svc.sweep();
        expect(r).toEqual({ scanned: 1, expired: 0, reminded: 0, repaired: 1, skipped: null });
        expect(orders.cancelOrder).toHaveBeenCalledTimes(2);
        expect(orders.cancelOrder.mock.calls[1][1]).toMatchObject({ orderId: 151, reason: expect.stringContaining('earlier failed cancellation') });
        expect(conn.ran(/SET cancelledAt = COALESCE\(cancelledAt, NOW\(\)\) WHERE orderId = \?/)[0].params).toEqual([151]);
        expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('repairStranded counts only orders it could cancel', async () => {
        sqlRoutes.push({ re: /t\.expiredAt IS NOT NULL\)/, rows: () => [{ orderId: 151, orderCode: 'ORD51' }, { orderId: 152, orderCode: 'ORD52' }, { orderId: 153, orderCode: 'ORD53' }] });
        conn.repo(Order).rows = [{ id: 151, channels: [channels[1]] }, { id: 152, channels: [channels[1]] }];
        orders.cancelOrder.mockImplementationOnce(async () => errorResult('nope', 'X'));
        expect(await (svc as any).repairStranded()).toBe(1);
        expect(orders.cancelOrder).toHaveBeenCalledTimes(2);
    });
});
