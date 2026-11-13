import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentMethod } from '@vendure/core';
import { FakeConnection } from '../__tests__/fakes';
import { ReconciliationService } from './reconciliation.service';
import { configureObservability } from './runtime';

const NOW = Date.now();
const hourAgo = Math.floor(NOW / 1000) - 3600;

function pi(id: string, over: Record<string, any> = {}) {
    return { id, status: 'succeeded', amount: 12999, currency: 'gbp', created: hourAgo, metadata: { orderCode: 'ORD-' + id, channelToken: 'tok-elite' }, ...over };
}

let conn: FakeConnection;
let state: Map<string, string>;
let known: string[];
let knownAmount = 12999;
let events: any[];
let observability: any;
let ops: { alert: ReturnType<typeof vi.fn> };
let svc: ReconciliationService;
let premium = true;
let options: any;
let stripePages: any[][];

beforeEach(() => {
    state = new Map();
    known = ['pi_known1'];
    knownAmount = 12999;
    events = [];
    premium = true;
    options = { reconciliation: { enabled: true, lookbackDays: 3 } };
    configureObservability({ getOptions: () => options, hasPremiumAccess: () => premium });
    conn = new FakeConnection({
        query: (sql: string, params: any[] = []) => {
            const s = sql.replace(/\s+/g, ' ');
            if (/SELECT p\.`transactionId`, p\.metadata, p\.amount, p\.state/.test(s)) return known.map(t => ({ transactionId: t, metadata: null, amount: knownAmount, state: 'Settled', orderCode: 'ORD-' + t, orderId: 5, currencyCode: 'GBP' }));
            if (/INSERT INTO checkout_guard_state/.test(s)) { state.set(params[0], params[1]); return { affectedRows: 1 }; }
            if (/SELECT v FROM checkout_guard_state/.test(s)) { const v = state.get(params[0]); return v ? [{ v }] : []; }
            return [];
        },
    });
    conn.repo(PaymentMethod).rows = [
        { id: 1, code: 'stripe-elite', enabled: true, handler: { code: 'stripe', args: [{ name: 'apiKey', value: 'sk_test_x' }] }, channels: [{ id: 2, token: 'tok-elite' }] },
        { id: 2, code: 'stripe-shared', enabled: true, handler: { code: 'stripe', args: [{ name: 'apiKey', value: 'sk_test_x' }] }, channels: [{ id: 3, token: 'tok-other' }] },
        { id: 3, code: 'stripe-off', enabled: false, handler: { code: 'stripe', args: [{ name: 'apiKey', value: 'sk_test_off' }] }, channels: [{ id: 2 }] },
        { id: 4, code: 'stripe-bad', enabled: true, handler: { code: 'stripe', args: [{ name: 'apiKey', value: 'pk_live_nope' }] }, channels: [{ id: 2 }] },
    ];
    observability = {
        existingPaymentEventRefs: vi.fn(async (kind: string, refs: string[]) => new Set(events.filter(e => e.kind === kind && refs.includes(e.providerRef)).map(e => e.providerRef))),
        recordPaymentEvent: vi.fn(async (input: any) => { events.push({ id: events.length + 1, ...input }); return events.length; }),
        pruneFunnel: vi.fn(async () => 0),
        prunePaymentEvents: vi.fn(async () => 0),
    };
    ops = { alert: vi.fn(async () => undefined) };
    svc = new ReconciliationService(conn as any, { isServer: false, isWorker: true } as any, observability, ops as any);
    stripePages = [[
        pi('pi_known1'),
        pi('pi_orphanA'),
        pi('pi_orphanB', { status: 'requires_capture', amount: 500000 }),
        pi('pi_fresh', { created: Math.floor(NOW / 1000) - 60 }),
        pi('pi_foreign', { metadata: {} }),
        pi('pi_canceled', { status: 'canceled' }),
    ]];
    let page = 0;
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
        expect(init.headers.Authorization).toBe('Bearer sk_test_x');
        expect(url).toContain('created%5Bgte%5D=');
        if (!url.includes('starting_after')) page = 0; // a fresh listing
        const data = stripePages[page] || [];
        page++;
        return { ok: true, status: 200, json: async () => ({ data, has_more: page < stripePages.length }) };
    });
});
afterEach(() => { delete (globalThis as any).fetch; });

describe('runOnce', () => {
    it('writes one orphan event per unmatched intent, alerts once, and persists the run', async () => {
        const r = await svc.runOnce();
        expect(r).toMatchObject({ ran: true, accounts: 1, intentsScanned: 6, orphansFound: 2, orphansNew: 2, incomplete: false });
        expect((globalThis as any).fetch).toHaveBeenCalledTimes(1); // one account: two enabled methods share the key
        expect(events.map(e => [e.kind, e.providerRef, e.channelId, e.orderCode, e.amountMinor, e.currency, e.code])).toEqual([
            ['orphan', 'pi_orphanA', 2, 'ORD-pi_orphanA', 12999, 'GBP', 'succeeded'],
            ['orphan', 'pi_orphanB', 2, 'ORD-pi_orphanB', 500000, 'GBP', 'requires_capture'],
        ]);
        expect(ops.alert).toHaveBeenCalledTimes(1);
        expect(ops.alert.mock.calls[0][0]).toMatchObject({ event: 'reconciliation.summary', provider: 'stripe' });
        expect(ops.alert.mock.calls[0][0].text).toContain('2 Stripe payment(s) with no Vendure payment row (last 3 day(s))');
        expect(ops.alert.mock.calls[0][0].detail.orphans).toHaveLength(2);
        expect(JSON.parse(state.get('reconcile:last')!)).toMatchObject({ ran: true, orphansNew: 2 });
        expect((await svc.status()).lastRun).toMatchObject({ orphansNew: 2 });
    });

    it('does not re-record or re-alert still-orphaned intents on the next run', async () => {
        await svc.runOnce();
        const second = await svc.runOnce();
        expect(second).toMatchObject({ ran: true, orphansFound: 2, orphansNew: 0 });
        expect(events).toHaveLength(2);
        expect(ops.alert).toHaveBeenCalledTimes(1);
        expect(JSON.parse(state.get('reconcile:last')!)).toMatchObject({ orphansNew: 0 });
    });

    it('maps an intent to its channel by token, falling back to the account channel', async () => {
        stripePages = [[pi('pi_x', { metadata: { orderCode: 'A', channelToken: 'tok-other' } }), pi('pi_y', { metadata: { orderCode: 'B', channelToken: 'tok-unknown' } })]];
        await svc.runOnce();
        expect(events.map(e => [e.providerRef, e.channelId])).toEqual([['pi_x', 3], ['pi_y', 2]]);
    });

    it('flags an incomplete listing and still records what it saw', async () => {
        stripePages = [[pi('pi_orphanA')], [pi('pi_orphanC')]];
        (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
        const r = await svc.runOnce();
        expect(r).toMatchObject({ ran: true, incomplete: true, intentsScanned: 0, orphansNew: 0 });
        expect(ops.alert).not.toHaveBeenCalled();
    });

    it('skips when premium is locked, when disabled (unless forced), or without a Stripe account', async () => {
        premium = false;
        expect(await svc.runOnce()).toMatchObject({ ran: false, reason: 'premium_locked' });
        premium = true;
        options = { reconciliation: { enabled: false } };
        expect(await svc.runOnce()).toMatchObject({ ran: false, reason: 'disabled' });
        expect((await svc.runOnce({ force: true })).ran).toBe(true);
        conn.repo(PaymentMethod).rows = [];
        expect(await svc.runOnce({ force: true })).toMatchObject({ ran: true, accounts: 0, intentsScanned: 0 });
        expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
    });

    it('records a failed run', async () => {
        observability.existingPaymentEventRefs.mockImplementation(async () => { throw new Error('db down'); });
        const r = await svc.runOnce();
        expect(r).toMatchObject({ ran: true, reason: 'error', incomplete: true });
        expect(JSON.parse(state.get('reconcile:last')!)).toMatchObject({ reason: 'error' });
    });

    it('reports status with the lookback clamp and the schedule', async () => {
        options = { reconciliation: { enabled: true, lookbackDays: 90 } };
        expect(await svc.status()).toMatchObject({ enabled: true, premium: true, lookbackDays: 30, schedule: '10 4 * * *', lastRun: null });
        options = { reconciliation: { lookbackDays: 0 } };
        expect((await svc.status()).lookbackDays).toBe(3);
        state.set('reconcile:last', JSON.stringify({ ran: true, startedAt: '2026-09-01T00:00:00Z', orphansNew: 5 }));
        expect((await svc.status()).lastRun).toMatchObject({ orphansNew: 5 });
    });
});

describe('amount drift (premium, opt-in)', () => {
    it('is not checked unless reconciliation.amountDrift is on', async () => {
        knownAmount = 10000;
        const r = await svc.runOnce();
        expect(r.driftFound).toBeUndefined();
        expect(events.filter(e => e.kind === 'amount_drift')).toHaveLength(0);
    });

    it('flags a known intent whose Stripe amount differs, once, and alerts', async () => {
        options = { reconciliation: { enabled: true, lookbackDays: 3, amountDrift: true } };
        knownAmount = 10000;
        const r = await svc.runOnce();
        expect(r).toMatchObject({ driftFound: 1, driftNew: 1 });
        const drift = events.filter(e => e.kind === 'amount_drift');
        expect(drift).toHaveLength(1);
        expect(drift[0]).toMatchObject({ providerRef: 'pi_known1', orderCode: 'ORD-pi_known1', amountMinor: 12999, code: 'stripe_more' });
        expect(ops.alert.mock.calls.map(c => c[0].event)).toContain('payment.amount_drift');
        const again = await svc.runOnce();
        expect(again).toMatchObject({ driftFound: 1, driftNew: 0 });
    });

    it('leaves matching amounts alone', async () => {
        options = { reconciliation: { enabled: true, lookbackDays: 3, amountDrift: true } };
        const r = await svc.runOnce();
        expect(r).toMatchObject({ driftFound: 0, driftNew: 0 });
    });
});
