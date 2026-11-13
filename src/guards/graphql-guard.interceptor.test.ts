import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom, of } from 'rxjs';
import { CheckoutGuardGraphqlInterceptor, isFailedLogin, setGraphqlGuardRuntime, GraphqlGuardRuntime } from './graphql-guard.interceptor';
import { _resetLimiterBackends } from './limiter-store';
import { resolveCardTestingOptions } from './card-testing';

function ctxFor(parent: string, field: string, apiType: 'admin' | 'shop', ip: string, args: any = {}) {
    // The mocked core helper returns this object as the RequestContext.
    const req: any = { ip, headers: {}, socket: { remoteAddress: ip }, vendureRequestContext: { apiType } };
    return {
        getType: () => 'graphql',
        getArgs: () => [undefined, args, { req }, { parentType: { name: parent }, fieldName: field }],
    } as any;
}

let failures = 0;
let lockouts: any[] = [];
let opts: { login?: any; lookup?: any; gate?: any } = {};

const rt: GraphqlGuardRuntime = {
    loginGuard: () => opts.login,
    orderLookup: () => opts.lookup,
    autoOrderGate: () => opts.gate ?? null,
    clientIp: () => ({}),
    countOrderFailures: async () => failures,
    onLoginLockout: info => { lockouts.push(info); },
};

vi.mock('@vendure/core', async () => {
    class I18nError extends Error {
        constructor(message: string, public variables: any = {}, public code?: string, public logLevel?: any) { super(message); }
    }
    class RequestContext {}
    return {
        I18nError, RequestContext, LogLevel: { Verbose: 4 }, PaymentMethod: class {},
        Logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), verbose: vi.fn() },
        // The interceptor reads the context through this helper when the core exports it.
        internal_getRequestContext: (req: any) => req.vendureRequestContext,
    };
});

const call = (i: CheckoutGuardGraphqlInterceptor, c: any, result: any = { id: 1 }) => firstValueFrom(i.intercept(c, { handle: () => of(result) }));

describe('CheckoutGuardGraphqlInterceptor', () => {
    let activeOrder: any;
    let interceptor: CheckoutGuardGraphqlInterceptor;
    let methods: Record<string, string>;

    beforeEach(() => {
        failures = 0; lockouts = []; opts = {};
        activeOrder = { code: 'ORD1' };
        methods = { 'stripe-card': 'stripe', 'bank-transfer': 'bank-transfer' };
        const conn: any = { rawConnection: { getRepository: () => ({ findOne: async ({ where }: any) => (methods[where.code] ? { handler: { code: methods[where.code] } } : null) }) } };
        interceptor = new CheckoutGuardGraphqlInterceptor({ getActiveOrder: async () => activeOrder } as any, conn);
        setGraphqlGuardRuntime(rt);
    });
    afterEach(() => { setGraphqlGuardRuntime(null); _resetLimiterBackends(); });

    it('does nothing while every guard is off (the default)', async () => {
        const bad = { errorCode: 'INVALID_CREDENTIALS_ERROR' };
        for (let i = 0; i < 20; i++) expect(await call(interceptor, ctxFor('Mutation', 'login', 'admin', '203.0.113.50'), bad)).toBe(bad);
        expect(await call(interceptor, ctxFor('Query', 'orderByCode', 'shop', '203.0.113.50'))).toEqual({ id: 1 });
        failures = 99;
        expect(await call(interceptor, ctxFor('Mutation', 'createStripePaymentIntent', 'shop', '203.0.113.50'))).toEqual({ id: 1 });
    });

    it('login guard: locks a connection out after maxFailures, even with the right password', async () => {
        opts.login = { enabled: true, maxFailures: 3, windowMinutes: 15 };
        const bad = { errorCode: 'INVALID_CREDENTIALS_ERROR', __typename: 'InvalidCredentialsError' };
        for (let i = 0; i < 3; i++) await call(interceptor, ctxFor('Mutation', 'login', 'admin', '203.0.113.60'), bad);
        await new Promise(r => setTimeout(r, 5));
        expect(lockouts).toHaveLength(1);
        expect(lockouts[0]).toMatchObject({ ip: '203.0.113.60', api: 'admin', failures: 3 });
        await expect(call(interceptor, ctxFor('Mutation', 'login', 'admin', '203.0.113.60'), { id: 'ok' })).rejects.toThrow(/Too many failed login attempts/);
        // Another connection and the other API are unaffected.
        expect(await call(interceptor, ctxFor('Mutation', 'login', 'admin', '203.0.113.61'), { id: 'ok' })).toEqual({ id: 'ok' });
        expect(await call(interceptor, ctxFor('Mutation', 'authenticate', 'shop', '203.0.113.60'), { id: 'ok' })).toEqual({ id: 'ok' });
    });

    it('login guard: counts a failure the transaction interceptor hands over as a Promise', async () => {
        opts.login = { enabled: true, maxFailures: 1 };
        await call(interceptor, ctxFor('Mutation', 'login', 'shop', '203.0.113.65'), Promise.resolve({ errorCode: 'INVALID_CREDENTIALS_ERROR' }));
        await new Promise(r => setTimeout(r, 5));
        await expect(call(interceptor, ctxFor('Mutation', 'login', 'shop', '203.0.113.65'))).rejects.toThrow(/Too many failed login attempts/);
    });

    it('login guard: successful logins never count; apis limits the scope', async () => {
        opts.login = { enabled: true, maxFailures: 2, apis: 'shop' };
        for (let i = 0; i < 5; i++) await call(interceptor, ctxFor('Mutation', 'login', 'shop', '203.0.113.70'), { id: 'user' });
        expect(await call(interceptor, ctxFor('Mutation', 'login', 'shop', '203.0.113.70'), { id: 'user' })).toEqual({ id: 'user' });
        const bad = { errorCode: 'INVALID_CREDENTIALS_ERROR' };
        for (let i = 0; i < 5; i++) await call(interceptor, ctxFor('Mutation', 'login', 'admin', '203.0.113.70'), bad);
        expect(await call(interceptor, ctxFor('Mutation', 'login', 'admin', '203.0.113.70'), { id: 'ok' })).toEqual({ id: 'ok' });
    });

    it('orderByCode limit: Shop API only, per connection', async () => {
        opts.lookup = { enabled: true, capacity: 2, windowSeconds: 60 };
        await call(interceptor, ctxFor('Query', 'orderByCode', 'shop', '203.0.113.80'));
        await call(interceptor, ctxFor('Query', 'orderByCode', 'shop', '203.0.113.80'));
        await expect(call(interceptor, ctxFor('Query', 'orderByCode', 'shop', '203.0.113.80'))).rejects.toThrow(/Too many order lookups/);
        expect(await call(interceptor, ctxFor('Query', 'orderByCode', 'admin', '203.0.113.80'))).toEqual({ id: 1 });
    });

    it('automatic per-order gate: refuses card payment mutations past the cap, never bank transfer', async () => {
        opts.gate = resolveCardTestingOptions({ maxFailedPerOrder: 3 });
        failures = 2;
        expect(await call(interceptor, ctxFor('Mutation', 'createStripePaymentIntent', 'shop', '203.0.113.90'))).toEqual({ id: 1 });
        failures = 3;
        await expect(call(interceptor, ctxFor('Mutation', 'createStripePaymentIntent', 'shop', '203.0.113.90'))).rejects.toThrow(/Too many failed payment attempts/);
        await expect(call(interceptor, ctxFor('Mutation', 'addPaymentToOrder', 'shop', '203.0.113.90', { input: { method: 'stripe-card' } }))).rejects.toThrow(/Too many failed payment attempts/);
        expect(await call(interceptor, ctxFor('Mutation', 'addPaymentToOrder', 'shop', '203.0.113.90', { input: { method: 'bank-transfer' } }))).toEqual({ id: 1 });
        activeOrder = undefined;
        expect(await call(interceptor, ctxFor('Mutation', 'createStripePaymentIntent', 'shop', '203.0.113.90'))).toEqual({ id: 1 });
    });

    it('ignores field resolvers and REST', async () => {
        opts.lookup = { enabled: true, capacity: 0 };
        expect(await call(interceptor, ctxFor('Order', 'orderByCode', 'shop', '203.0.113.95'))).toEqual({ id: 1 });
        const rest = { getType: () => 'http', getArgs: () => [] } as any;
        expect(await call(interceptor, rest)).toEqual({ id: 1 });
    });

    it('isFailedLogin', () => {
        expect(isFailedLogin({ errorCode: 'INVALID_CREDENTIALS_ERROR' })).toBe(true);
        expect(isFailedLogin({ id: 1 })).toBe(false);
        expect(isFailedLogin(null)).toBe(false);
    });
});
