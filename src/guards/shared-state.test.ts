import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CacheLimiterBackend, MemoryLimiterBackend, _resetLimiterBackends, currentLimiterStore, hitFixedWindow, peekFixedWindow,
    resetFixedWindow, setLimiterBackends, windowBucket, LimiterBackend,
} from './limiter-store';
import { CardTestingGate, _resetCardTestingHooks, resolveCardTestingOptions, setCardTestingBlockStore, setFailureLookup } from './card-testing';
import { createMutationRateLimitHandler } from './mutation-rate-limit';

vi.mock('@vendure/core', () => ({ Logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), verbose: vi.fn() } }));

afterEach(() => { _resetLimiterBackends(); _resetCardTestingHooks(); });

/** A shared store double that counts like the database table. */
function fakeShared(kind: 'database' | 'cache'): LimiterBackend & { rows: Map<string, number>; fail: boolean } {
    const rows = new Map<string, number>();
    const b: any = {
        kind, rows, fail: false,
        async incr(bucket: string, by: number) { if (b.fail) throw new Error('down'); rows.set(bucket, (rows.get(bucket) || 0) + by); return rows.get(bucket)!; },
        async peek(bucket: string) { if (b.fail) throw new Error('down'); return rows.get(bucket) || 0; },
        async reset(bucket: string) { rows.delete(bucket); },
    };
    return b;
}

function makeRes(): any {
    const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.setHeader = (name: string, value: string) => { res.headers[name.toLowerCase()] = value; return res; };
    res.json = (payload: unknown) => { res.body = payload; return res; };
    return res;
}
const COUPON = 'mutation { applyCouponCode(couponCode: "SAVE") { ... on Order { id } } }';
async function drive(handler: any, ip = '198.51.100.7') {
    const res = makeRes();
    let passed = false;
    await new Promise<void>(resolve => {
        const r = { method: 'POST', headers: {}, ip, socket: { remoteAddress: ip }, body: { query: COUPON } };
        const origJson = res.json;
        res.json = (p: unknown) => { origJson(p); resolve(); return res; };
        handler(r, res, () => { passed = true; resolve(); });
    });
    return { res, passed };
}

describe('fixed-window limiter store', () => {
    it('counts in memory by default', async () => {
        expect(currentLimiterStore()).toBe('memory');
        const t = 1_000_000_000_000;
        expect((await hitFixedWindow('r', 'k', 60_000, 1, t)).count).toBe(1);
        expect((await hitFixedWindow('r', 'k', 60_000, 2, t + 1000)).count).toBe(3);
        expect(await peekFixedWindow('r', 'k', 60_000, t + 2000)).toBe(3);
        // Next window starts from zero.
        expect((await hitFixedWindow('r', 'k', 60_000, 1, t + 60_000)).count).toBe(1);
        await resetFixedWindow('r', 'k', 60_000, t + 60_000);
        expect(await peekFixedWindow('r', 'k', 60_000, t + 60_000)).toBe(0);
    });

    it('uses the selected shared store, and falls back to memory when it fails', async () => {
        const db = fakeShared('database');
        let kind: any = 'database';
        setLimiterBackends({ database: db }, () => kind);
        expect(currentLimiterStore()).toBe('database');
        const r = await hitFixedWindow('x', 'k', 60_000, 1, 5_000);
        expect(r).toMatchObject({ count: 1, store: 'database' });
        expect(db.rows.get(windowBucket('x', 'k', 60_000, 0))).toBe(1);
        db.fail = true;
        expect((await hitFixedWindow('x', 'k', 60_000, 1, 5_000)).store).toBe('memory');
        kind = 'cache'; // asked for, but not installed
        expect(currentLimiterStore()).toBe('memory');
    });

    it('bucket ids carry no raw address and fit the column', () => {
        const b = windowBucket('login:admin', '203.0.113.5', 900_000, 42);
        expect(b).toMatch(/^[0-9a-f]{40}$/);
        expect(b).not.toContain('203');
    });

    it('memory and cache backends', async () => {
        const m = new MemoryLimiterBackend(() => 0);
        expect(await m.incr('a', 1, 10)).toBe(1);
        expect(await m.incr('a', 1, 10)).toBe(2);
        const store = new Map<string, any>();
        const cache = { get: async (k: string) => store.get(k), set: async (k: string, v: any, o?: any) => { store.set(k, v); expect(o.ttl).toBeGreaterThan(0); }, delete: async (k: string) => { store.delete(k); } };
        const c = new CacheLimiterBackend(cache, () => 0);
        expect(await c.incr('b', 2, 60_000)).toBe(2);
        expect(await c.incr('b', 1, 60_000)).toBe(3);
        await c.reset('b');
        expect(await c.peek('b')).toBe(0);
    });
});

describe('mutation limits on a shared store', () => {
    it('shares the count between two handlers (two processes) and still answers 429', async () => {
        const db = fakeShared('database');
        setLimiterBackends({ database: db }, () => 'database');
        const a = createMutationRateLimitHandler({ limits: { applyCouponCode: { capacity: 2, windowMs: 60_000 } }, onLimited: () => undefined, cardTesting: false });
        const b = createMutationRateLimitHandler({ limits: { applyCouponCode: { capacity: 2, windowMs: 60_000 } }, onLimited: () => undefined, cardTesting: false });
        expect((await drive(a)).passed).toBe(true);
        expect((await drive(b)).passed).toBe(true);
        const third = await drive(a);
        expect(third.passed).toBe(false);
        expect(third.res.statusCode).toBe(429);
    });

    it('reads changed limits from getLimits without a restart', async () => {
        let cap = 1;
        const h = createMutationRateLimitHandler({ getLimits: () => ({ applyCouponCode: { capacity: cap, windowMs: 60_000 } }), onLimited: () => undefined, cardTesting: false });
        expect((await drive(h, '192.0.2.1')).passed).toBe(true);
        expect((await drive(h, '192.0.2.1')).passed).toBe(false);
        cap = 5;
        expect((await drive(h, '192.0.2.1')).passed).toBe(true);
    });
});

describe('card-testing gate: shared block list and unblock', () => {
    it('stores a block, and an unblock means earlier failures no longer count', async () => {
        let t = 2_000_000;
        const saved: any[] = [];
        setCardTestingBlockStore({ save: async b => { saved.push(b); }, load: async () => ({ blocks: [], cleared: new Map() }) });
        const lookup = vi.fn(async (_ip: string, _w: number, since?: Date) => (since ? 0 : 5));
        setFailureLookup(lookup);
        const gate = new CardTestingGate(resolveCardTestingOptions({ maxFailedPerIp: 4 })!, () => t);
        expect((await gate.check('203.0.113.1', 'createStripePaymentIntent')).blocked).toBe(true);
        expect(saved[0]).toMatchObject({ ip: '203.0.113.1', failures: 5, surface: 'createStripePaymentIntent' });
        expect(gate.list().map(b => b.ip)).toEqual(['203.0.113.1']);
        gate.unblock('203.0.113.1');
        t += 1000;
        const v = await gate.check('203.0.113.1', 'createStripePaymentIntent');
        expect(v.blocked).toBe(false);
        expect(lookup.mock.calls.at(-1)?.[2]).toBeInstanceOf(Date);
    });

    it('with the memory store, stored blocks are not enforced (a restart clears them, as in 0.3)', async () => {
        const state = { blocks: [{ ip: '203.0.113.4', failures: 4, blockedAt: new Date(1000), blockedUntil: new Date(9_999_999), surface: 'addPaymentToOrder' }], cleared: new Map<string, Date>() };
        setCardTestingBlockStore({ save: async () => undefined, load: async () => state }, () => false);
        setFailureLookup(async () => 0);
        const gate = new CardTestingGate(resolveCardTestingOptions({ maxFailedPerIp: 4 })!, () => 2000);
        expect((await gate.check('203.0.113.4', 'addPaymentToOrder')).blocked).toBe(false);
    });

    it('picks up blocks and unblocks other processes wrote (shared store)', async () => {
        let t = 5_000_000;
        let state = { blocks: [{ ip: '203.0.113.2', failures: 4, blockedAt: new Date(t - 1000), blockedUntil: new Date(t + 600_000), surface: 'addPaymentToOrder' }], cleared: new Map<string, Date>() };
        setCardTestingBlockStore({ save: async () => undefined, load: async () => state }, () => true);
        setFailureLookup(async () => 0);
        const gate = new CardTestingGate(resolveCardTestingOptions({ maxFailedPerIp: 4 })!, () => t);
        expect((await gate.check('203.0.113.2', 'addPaymentToOrder')).blocked).toBe(true);
        state = { blocks: [], cleared: new Map([['203.0.113.2', new Date(t + 10)]]) };
        t += 31_000;
        expect((await gate.check('203.0.113.2', 'addPaymentToOrder')).blocked).toBe(false);
    });

    it('setOptions keeps blocks in force', async () => {
        setFailureLookup(async () => 9);
        const gate = new CardTestingGate(resolveCardTestingOptions({ maxFailedPerIp: 4 })!, () => 1);
        expect((await gate.check('203.0.113.3', 'addPaymentToOrder')).blocked).toBe(true);
        gate.setOptions(resolveCardTestingOptions({ maxFailedPerIp: 50 })!);
        expect((await gate.check('203.0.113.3', 'addPaymentToOrder')).blocked).toBe(true);
    });
});
