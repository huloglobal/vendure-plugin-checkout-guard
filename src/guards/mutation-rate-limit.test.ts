import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_MUTATION_RATE_LIMITS,
    createMutationRateLimitHandler,
    extractMutationNames,
    rateLimitedBody,
    resolveMutationRateLimits,
    shopApiMutationRateLimitMiddleware,
    rateLimitBucket,
    stripGraphQlComments,
} from './mutation-rate-limit';

const KNOWN = Object.keys(DEFAULT_MUTATION_RATE_LIMITS);

describe('resolveMutationRateLimits', () => {
    it('returns a copy of the defaults', () => {
        const limits = resolveMutationRateLimits();
        expect(limits).toEqual(DEFAULT_MUTATION_RATE_LIMITS);
        expect(limits.applyCouponCode).not.toBe(DEFAULT_MUTATION_RATE_LIMITS.applyCouponCode);
        expect(limits.applyCouponCode).toEqual({ capacity: 10, windowMs: 60_000 });
        expect(limits.addPaymentToOrder.capacity).toBe(6);
        expect(limits.createStripePaymentIntent.capacity).toBe(6);
        expect(limits.transitionOrderToState.capacity).toBe(20);
    });

    it('merges partial overrides, adds new names and removes disabled ones', () => {
        const limits = resolveMutationRateLimits({
            applyCouponCode: { capacity: 3 },
            addPaymentToOrder: false,
            createStripePaymentIntent: { capacity: 0 },
            registerCustomerAccount: { capacity: 5, windowMs: 120_000 },
            ' ': { capacity: 1 },
        });
        expect(limits.applyCouponCode).toEqual({ capacity: 3, windowMs: 60_000 });
        expect(limits.addPaymentToOrder).toBeUndefined();
        expect(limits.createStripePaymentIntent).toBeUndefined();
        expect(limits.registerCustomerAccount).toEqual({ capacity: 5, windowMs: 120_000 });
        expect(Object.keys(limits).sort()).toEqual(['applyCouponCode', 'registerCustomerAccount', 'transitionOrderToState']);
    });
});

describe('extractMutationNames', () => {
    it('finds limited mutations in a single document', () => {
        const body = { query: 'mutation ApplyCoupon($code: String!) { applyCouponCode(couponCode: $code) { ... on Order { id } } }' };
        expect(extractMutationNames(body, KNOWN)).toEqual(['applyCouponCode']);
    });

    it('handles aliases, whitespace and batched bodies', () => {
        const body = [
            { query: 'mutation { pay: addPaymentToOrder (input: { method: "stripe", metadata: {} }) { ... on Order { id } } }' },
            { query: 'mutation {\n  transitionOrderToState(state: "ArrangingPayment") { ... on Order { id } }\n}' },
            { query: '{ activeOrder { id } }' },
        ];
        expect(extractMutationNames(body, KNOWN)).toEqual(['addPaymentToOrder', 'transitionOrderToState']);
    });

    it('ignores queries, mentions without an argument list and prefixed names', () => {
        expect(extractMutationNames({ query: 'query { applyCouponCode(couponCode: "x") { id } }' }, KNOWN)).toEqual([]);
        expect(extractMutationNames({ query: 'mutation { setOrderCustomFields(input: { note: "applyCouponCode" }) { id } }' }, KNOWN)).toEqual([]);
        expect(extractMutationNames({ query: 'mutation { myapplyCouponCode(x: 1) { id } }' }, KNOWN)).toEqual([]);
    });

    it('tolerates malformed bodies', () => {
        expect(extractMutationNames(undefined, KNOWN)).toEqual([]);
        expect(extractMutationNames('mutation { applyCouponCode(couponCode: "x") }', KNOWN)).toEqual([]);
        expect(extractMutationNames({ query: 42 }, KNOWN)).toEqual([]);
        expect(extractMutationNames([null, 1, { query: null }], KNOWN)).toEqual([]);
    });
});

function makeReq(query: string, ip = '198.51.100.1', method = 'POST'): any {
    return { method, headers: {}, socket: { remoteAddress: ip }, body: { query } };
}

function makeRes(): any {
    const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.setHeader = (name: string, value: string) => { res.headers[name.toLowerCase()] = value; return res; };
    res.json = (payload: unknown) => { res.body = payload; return res; };
    return res;
}

const COUPON = 'mutation { applyCouponCode(couponCode: "SAVE") { ... on Order { id } } }';
const PAY = 'mutation { addPaymentToOrder(input: { method: "stripe", metadata: {} }) { ... on Order { id } } }';

describe('createMutationRateLimitHandler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-11T10:00:00Z'));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    function drive(handler: ReturnType<typeof createMutationRateLimitHandler>, req: any) {
        const res = makeRes();
        let passed = false;
        handler(req, res, () => { passed = true; });
        return { res, passed };
    }

    it('lets requests through until the bucket drains, then answers 429', () => {
        const limited: any[] = [];
        const handler = createMutationRateLimitHandler({ limits: { applyCouponCode: { capacity: 3, windowMs: 60_000 } }, onLimited: info => limited.push(info) });
        for (let i = 0; i < 3; i++) {
            expect(drive(handler, makeReq(COUPON)).passed).toBe(true);
        }
        const { res, passed } = drive(handler, makeReq(COUPON));
        expect(passed).toBe(false);
        expect(res.statusCode).toBe(429);
        expect(res.headers['retry-after']).toBe('60');
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toEqual(rateLimitedBody('applyCouponCode'));
        expect(res.body.errors[0].message).toBe('rate_limited');
        expect(limited).toEqual([{ mutation: 'applyCouponCode', key: '198.51.100.1', limit: { capacity: 3, windowMs: 60_000 } }]);
    });

    it('charges one token per aliased call, so one document cannot carry many guesses', () => {
        const handler = createMutationRateLimitHandler({ limits: { applyCouponCode: { capacity: 3, windowMs: 60_000 } }, onLimited: () => undefined, cardTesting: false });
        const many = `mutation { ${Array.from({ length: 8 }, (_, i) => `a${i}: applyCouponCode(couponCode: "C${i}") { __typename }`).join(' ')} }`;
        const r = drive(handler, makeReq(many, '198.51.100.40'));
        expect(r.passed).toBe(false);
        expect(r.res.statusCode).toBe(429);
        // Two aliases spend two of the three tokens: one plain call still fits, a second does not.
        const two = 'mutation { a: applyCouponCode(couponCode: "A") { __typename } b: applyCouponCode(couponCode: "B") { __typename } }';
        expect(drive(handler, makeReq(two, '198.51.100.41')).passed).toBe(true);
        expect(drive(handler, makeReq(COUPON, '198.51.100.41')).passed).toBe(true);
        expect(drive(handler, makeReq(COUPON, '198.51.100.41')).passed).toBe(false);
    });

    it('charges every operation of a batched body', () => {
        const handler = createMutationRateLimitHandler({ limits: { applyCouponCode: { capacity: 3, windowMs: 60_000 } }, onLimited: () => undefined, cardTesting: false });
        const req = makeReq(COUPON, '198.51.100.42');
        req.body = Array.from({ length: 4 }, () => ({ query: COUPON }));
        expect(drive(handler, req).passed).toBe(false);
    });

    it('an operation named after the field it calls costs one token, not two', () => {
        const handler = createMutationRateLimitHandler({ limits: { applyCouponCode: { capacity: 2, windowMs: 60_000 } }, onLimited: () => undefined, cardTesting: false });
        const named = 'mutation applyCouponCode($c: String!) { applyCouponCode(couponCode: $c) { __typename } }';
        expect(drive(handler, makeReq(named, '198.51.100.43')).passed).toBe(true);
        expect(drive(handler, makeReq(named, '198.51.100.43')).passed).toBe(true);
        expect(drive(handler, makeReq(named, '198.51.100.43')).passed).toBe(false);
    });

    it('persisted queries (hash only) are charged, and an unseen hash is never let through', () => {
        const { createHash } = require('crypto') as typeof import('crypto');
        const handler = createMutationRateLimitHandler({ limits: { applyCouponCode: { capacity: 2, windowMs: 60_000 } }, onLimited: () => undefined, cardTesting: false });
        const hash = createHash('sha256').update(COUPON).digest('hex');
        const ext = { persistedQuery: { version: 1, sha256Hash: hash } };
        const hashOnly = () => { const r = makeReq('', '198.51.100.44'); r.body = { extensions: ext }; return r; };
        // Unseen hash: answered like Apollo's PersistedQueryNotFound, never passed on.
        const unseen = drive(handler, hashOnly());
        expect(unseen.passed).toBe(false);
        expect(unseen.res.body.errors[0].extensions.code).toBe('PERSISTED_QUERY_NOT_FOUND');
        // Registration (document + hash) spends a token and teaches the hash.
        const reg = makeReq(COUPON, '198.51.100.44');
        reg.body.extensions = ext;
        expect(drive(handler, reg).passed).toBe(true);
        expect(drive(handler, hashOnly()).passed).toBe(true);
        const third = drive(handler, hashOnly());
        expect(third.passed).toBe(false);
        expect(third.res.statusCode).toBe(429);
        // A hash that does not match the document it came with is not learnt.
        const lie = makeReq('mutation { setOrderCustomFields(input: {}) { __typename } }', '198.51.100.45');
        lie.body.extensions = ext;
        const fresh = createMutationRateLimitHandler({ limits: { applyCouponCode: { capacity: 2, windowMs: 60_000 } }, onLimited: () => undefined, cardTesting: false });
        drive(fresh, lie);
        const r = makeReq('', '198.51.100.45'); r.body = { extensions: ext };
        expect(drive(fresh, r).res.body?.errors?.[0]?.extensions?.code).toBe('PERSISTED_QUERY_NOT_FOUND');
    });

    it('refills over time', () => {
        const handler = createMutationRateLimitHandler({ limits: { applyCouponCode: { capacity: 2, windowMs: 60_000 } }, onLimited: () => undefined });
        drive(handler, makeReq(COUPON));
        drive(handler, makeReq(COUPON));
        expect(drive(handler, makeReq(COUPON)).passed).toBe(false);
        vi.advanceTimersByTime(31_000);
        expect(drive(handler, makeReq(COUPON)).passed).toBe(true);
        expect(drive(handler, makeReq(COUPON)).passed).toBe(false);
    });

    it('keys buckets per IP and per mutation', () => {
        const handler = createMutationRateLimitHandler({
            limits: { applyCouponCode: { capacity: 1, windowMs: 60_000 }, addPaymentToOrder: { capacity: 1, windowMs: 60_000 } },
            onLimited: () => undefined,
        });
        expect(drive(handler, makeReq(COUPON, '198.51.100.1')).passed).toBe(true);
        expect(drive(handler, makeReq(COUPON, '198.51.100.1')).passed).toBe(false);
        expect(drive(handler, makeReq(COUPON, '198.51.100.2')).passed).toBe(true);
        expect(drive(handler, makeReq(PAY, '198.51.100.1')).passed).toBe(true);
        expect(drive(handler, makeReq(PAY, '198.51.100.1')).passed).toBe(false);
    });

    it('ignores non-POST requests, unrelated documents and unknown clients', () => {
        const handler = createMutationRateLimitHandler({ limits: { applyCouponCode: { capacity: 1, windowMs: 60_000 } }, onLimited: () => undefined });
        for (let i = 0; i < 3; i++) {
            expect(drive(handler, makeReq(COUPON, '198.51.100.1', 'GET')).passed).toBe(true);
            expect(drive(handler, makeReq('{ activeOrder { id } }')).passed).toBe(true);
            expect(drive(handler, { method: 'POST', headers: {}, body: { query: COUPON } }).passed).toBe(true);
            expect(drive(handler, { method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.1' }, body: undefined }).passed).toBe(true);
        }
    });

    it('supports a custom key function and a custom trusted header', () => {
        const handler = createMutationRateLimitHandler({
            limits: { applyCouponCode: { capacity: 1, windowMs: 60_000 } },
            keyFor: req => (req.headers['x-session'] as string) || null,
            onLimited: () => undefined,
        });
        const a = { method: 'POST', headers: { 'x-session': 'A' }, body: { query: COUPON } } as any;
        const b = { method: 'POST', headers: { 'x-session': 'B' }, body: { query: COUPON } } as any;
        expect(drive(handler, a).passed).toBe(true);
        expect(drive(handler, a).passed).toBe(false);
        expect(drive(handler, b).passed).toBe(true);

        const viaHeader = createMutationRateLimitHandler({ limits: { applyCouponCode: { capacity: 1, windowMs: 60_000 } }, clientIpHeader: 'x-client', onLimited: () => undefined });
        const c = { method: 'POST', headers: { 'x-client': '203.0.113.5' }, body: { query: COUPON } } as any;
        expect(drive(viaHeader, c).passed).toBe(true);
        expect(drive(viaHeader, c).passed).toBe(false);
    });

    it('passes everything when every limit is disabled', () => {
        const handler = createMutationRateLimitHandler({
            limits: { applyCouponCode: false, addPaymentToOrder: false, createStripePaymentIntent: false, transitionOrderToState: false },
        });
        for (let i = 0; i < 50; i++) expect(drive(handler, makeReq(COUPON)).passed).toBe(true);
    });

    it('exposes a Vendure middleware scoped to the shop API path', () => {
        expect(shopApiMutationRateLimitMiddleware().route).toBe('shop-api');
        const mw = shopApiMutationRateLimitMiddleware({}, 'store-api');
        expect(mw.route).toBe('store-api');
        expect(mw.beforeListen).toBeUndefined();
        expect(typeof mw.handler).toBe('function');
    });
});

describe('stripGraphQlComments / rateLimitBucket', () => {
    it('a comment between the field name and its arguments does not hide the mutation', () => {
        const doc = 'mutation { applyCouponCode # sneaky\n(couponCode: "A") { ... on Order { id } } }';
        expect(extractMutationNames({ query: doc }, ['applyCouponCode'])).toEqual(['applyCouponCode']);
        expect(stripGraphQlComments('a # b\nc')).toBe('a \nc');
        expect(stripGraphQlComments('"""doc # not a comment"""x')).toBe('""x');
    });
    it('buckets IPv6 clients per /64 and leaves IPv4 alone', () => {
        expect(rateLimitBucket('198.51.100.7')).toBe('198.51.100.7');
        expect(rateLimitBucket('::ffff:198.51.100.7')).toBe('::ffff:198.51.100.7');
        expect(rateLimitBucket('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
        expect(rateLimitBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
        expect(rateLimitBucket('2001:db8::5')).toBe(rateLimitBucket('2001:db8::1'));
        expect(rateLimitBucket(null)).toBeNull();
    });
});

describe('usage counter', () => {
    it('bumps rate_limit once per 429 and nothing when a request passes', async () => {
        const { setCounterSink } = await import('./counters');
        const seen: string[] = [];
        setCounterSink(name => seen.push(name));
        try {
            const handler = createMutationRateLimitHandler({ limits: { applyCouponCode: { capacity: 1, windowMs: 60_000 } }, onLimited: () => undefined });
            const body = { query: 'mutation { applyCouponCode(couponCode: "X") { __typename } }' };
            const req = (ip: string) => ({ method: 'POST', body, headers: {}, ip, socket: { remoteAddress: ip } } as any);
            const res = () => ({ status() { return this; }, setHeader() { return this; }, json() { return this; } } as any);
            let passed = 0;
            handler(req('203.0.113.9'), res(), () => { passed++; });
            handler(req('203.0.113.9'), res(), () => { passed++; });
            expect(passed).toBe(1);
            expect(seen).toEqual(['rate_limit']);
        } finally {
            setCounterSink(null);
        }
    });
});
