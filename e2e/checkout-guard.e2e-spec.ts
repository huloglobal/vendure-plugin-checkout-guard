import { mergeConfig, TransactionalConnection } from '@vendure/core';
import { createTestEnvironment, registerInitializer, MysqlInitializer, testConfig } from '@vendure/testing';
import gql from 'graphql-tag';
import { initialData } from '../../../e2e-shared/initial-data';
import { CheckoutGuardPlugin } from '../src/plugin';
import { SessionBoundOrderByCodeAccessStrategy } from '../src/guards';
import { BankTransferService } from '../src/bank-transfer';
import { ObservabilityService } from '../src/observability';
import { buildStripeSignatureHeader, configureStripeHold } from '../src/stripe-hold';
import { setBankTransferRuntime } from '../src/bank-transfer';
import { configureObservability } from '../src/observability';

/**
 * Runs against a real MariaDB (same dialect as production). SKIPPED unless
 * creds are provided via env, so it never fails on a machine without a DB:
 *   FP_E2E_DB_HOST FP_E2E_DB_PORT FP_E2E_DB_USER FP_E2E_DB_PASS
 */
const DB = process.env.FP_E2E_DB_HOST
    ? {
          host: process.env.FP_E2E_DB_HOST,
          port: Number(process.env.FP_E2E_DB_PORT || 3306),
          username: process.env.FP_E2E_DB_USER || 'root',
          password: process.env.FP_E2E_DB_PASS || '',
      }
    : null;

const PORT = 3067;
const BASE = `http://localhost:${PORT}`;
const PROXY_SECRET = 'e2e-proxy-secret';
const WEBHOOK_SECRET = 'whsec_e2e_test_secret';
const run = DB ? describe : describe.skip;

run('@huloglobal/vendure-plugin-checkout-guard (MariaDB)', () => {
    registerInitializer('mysql', new MysqlInitializer());

    const config = mergeConfig(testConfig, {
        apiOptions: { port: PORT },
        dbConnectionOptions: {
            type: 'mysql' as const,
            host: DB!.host, port: DB!.port, username: DB!.username, password: DB!.password,
            database: 'hulo_cg_e2e',
            synchronize: true,
        },
        orderOptions: {
            orderByCodeAccessStrategy: new SessionBoundOrderByCodeAccessStrategy('2h'),
        },
        plugins: [
            CheckoutGuardPlugin.init({
                publicBaseUrl: BASE,
                stripe: { webhookSecret: WEBHOOK_SECRET },
                bankTransfer: { expiryDays: 7, reminderAfterDays: 3 },
                trustedClientIp: { secret: PROXY_SECRET },
                rateLimits: { mutations: { applyCouponCode: { capacity: 3, windowMs: 60_000 } } },
            }),
        ],
    });
    const { server, adminClient, shopClient } = createTestEnvironment(config);

    const raw = () => (server as any).app.get(TransactionalConnection).rawConnection as { query(sql: string, params?: any[]): Promise<any> };
    const bank = () => (server as any).app.get(BankTransferService) as BankTransferService;
    const obs = () => (server as any).app.get(ObservabilityService) as ObservabilityService;
    const num = (id: string | number) => Number(String(id).replace(/^T_/, ''));

    beforeAll(async () => {
        await server.init({ initialData, productsCsvPath: '', customerCount: 0 } as any);
        // No licence in CI: unlock the premium paths the way a licence would,
        // so expiry sweeps and failed-payment recording are exercised.
        const premium = () => true;
        setBankTransferRuntime({ expiryDays: 7, reminderAfterDays: 3, hasPremiumAccess: premium });
        configureStripeHold({ hasPremiumAccess: premium });
        configureObservability({ hasPremiumAccess: premium });
    }, 120_000);

    /** Runs a shop mutation and names it in any thrown error. */
    async function shop(label: string, doc: any, vars?: any): Promise<any> {
        try { return await shopClient.query(doc, vars); }
        catch (e: any) { throw new Error(`${label}: ${e?.message || e}`); }
    }

    afterAll(async () => {
        await server.destroy();
    });

    let variantId: string;
    let shippingId: string;

    /** One-off catalogue + a bank-transfer payment method with real args. */
    async function ensureCatalogue() {
        await adminClient.asSuperAdmin();
        const { taxCategories } = await adminClient.query(gql`{ taxCategories { items { id isDefault } } }`);
        if (!taxCategories.items.length) {
            await adminClient.query(gql`mutation { createTaxCategory(input: { name: "Standard", isDefault: true }) { id } }`);
        }
        const { products } = await adminClient.query(gql`{ products(options: { filter: { slug: { eq: "cg-key" } } }) { items { id variants { id } } } }`);
        variantId = products.items[0]?.variants?.[0]?.id;
        if (!variantId) {
            const { createProduct } = await adminClient.query(gql`mutation {
                createProduct(input: { enabled: true, translations: [{ languageCode: en, name: "CG licence key", slug: "cg-key", description: "" }] }) { id }
            }`);
            const { createProductVariants } = await adminClient.query(gql`mutation ($productId: ID!) {
                createProductVariants(input: [{ productId: $productId, sku: "CG-KEY", price: 12000, trackInventory: FALSE, stockOnHand: 1000, translations: [{ languageCode: en, name: "CG licence key" }] }]) { id }
            }`, { productId: createProduct.id });
            variantId = createProductVariants[0].id;
        }
        const { shippingMethods } = await adminClient.query(gql`{ shippingMethods { items { id code } } }`);
        shippingId = shippingMethods.items.find((m: any) => m.code === 'cg-e2e-ship')?.id;
        if (!shippingId) {
            const { createShippingMethod } = await adminClient.query(gql`mutation {
                createShippingMethod(input: {
                    code: "cg-e2e-ship", fulfillmentHandler: "manual-fulfillment",
                    checker: { code: "default-shipping-eligibility-checker", arguments: [{ name: "orderMinimum", value: "0" }] },
                    calculator: { code: "default-shipping-calculator", arguments: [{ name: "rate", value: "0" }, { name: "includesTax", value: "auto" }, { name: "taxRate", value: "0" }] },
                    translations: [{ languageCode: en, name: "E2E delivery" }]
                }) { id }
            }`);
            shippingId = createShippingMethod.id;
        }
        const { paymentMethods } = await adminClient.query(gql`{ paymentMethods { items { id code } } }`);
        if (!paymentMethods.items.some((m: any) => m.code === 'bank-transfer')) {
            await adminClient.query(gql`mutation {
                createPaymentMethod(input: {
                    code: "bank-transfer", enabled: true,
                    translations: [{ languageCode: en, name: "Bank transfer" }],
                    handler: { code: "bank-transfer", arguments: [
                        { name: "accountName", value: "HULO GLOBAL LIMITED" }, { name: "accountNumber", value: "31138533" },
                        { name: "sortCode", value: "04-06-05" }, { name: "iban", value: "GB00TEST00000031138533" },
                        { name: "bic", value: "TESTGB2L" }, { name: "instructions", value: "Quote the reference." }, { name: "expiryDays", value: "7" }
                    ] },
                    checker: { code: "bank-transfer-eligibility", arguments: [
                        { name: "minAmountMinor", value: "0" }, { name: "maxAmountMinor", value: "0" }, { name: "allowGuests", value: "true" }, { name: "allowedCustomerGroupIds", value: "[]" }
                    ] }
                }) { id }
            }`);
        }
    }

    /** Guest cart on a fresh shop session, taken to ArrangingPayment. */
    async function startGuestOrder(email: string): Promise<{ id: string; code: string }> {
        (shopClient as any).authToken = undefined;
        delete (shopClient as any).headers?.Authorization;
        const add = await shop('addItemToOrder', gql`mutation ($id: ID!) {
            addItemToOrder(productVariantId: $id, quantity: 1) { ... on Order { id code } ... on ErrorResult { errorCode message } }
        }`, { id: variantId });
        if (!add.addItemToOrder.code) throw new Error(`addItemToOrder failed: ${JSON.stringify(add.addItemToOrder)}`);
        const cust = await shop('setCustomerForOrder', gql`mutation ($email: String!) {
            setCustomerForOrder(input: { emailAddress: $email, firstName: "Test", lastName: "Buyer" }) { ... on Order { id } ... on ErrorResult { errorCode message } }
        }`, { email });
        expect(cust.setCustomerForOrder.id).toBeTruthy();
        await shop('setOrderShippingAddress', gql`mutation {
            setOrderShippingAddress(input: { fullName: "Test Buyer", streetLine1: "1 High St", city: "London", postalCode: "SW1A 1AA", countryCode: "GB" }) { ... on Order { id } ... on ErrorResult { errorCode message } }
        }`);
        const ship = await shop('setOrderShippingMethod', gql`mutation ($id: [ID!]!) {
            setOrderShippingMethod(shippingMethodId: $id) { ... on Order { id } ... on ErrorResult { errorCode message } }
        }`, { id: [shippingId] });
        expect(ship.setOrderShippingMethod.id).toBeTruthy();
        const trans = await shop('transitionOrderToState', gql`mutation {
            transitionOrderToState(state: "ArrangingPayment") { ... on Order { id code state } ... on ErrorResult { errorCode message } }
        }`);
        expect(trans.transitionOrderToState.state).toBe('ArrangingPayment');
        return { id: trans.transitionOrderToState.id, code: trans.transitionOrderToState.code };
    }

    // ── HTTP contracts ─────────────────────────────────────────────────
    it('admin endpoints reject anonymous callers', async () => {
        for (const p of ['meta', 'settings', 'summary', 'holds', 'bank-transfers', 'events', 'funnel/summary']) {
            const res = await fetch(`${BASE}/checkout-guard/${p}`);
            expect([401, 403]).toContain(res.status);
        }
    });

    it('meta + settings answer for an admin', async () => {
        await adminClient.asSuperAdmin();
        const token = (adminClient as any).authToken as string;
        const meta = await (await fetch(`${BASE}/checkout-guard/meta`, { headers: { authorization: `Bearer ${token}` } })).json();
        expect(meta.name).toBe('@huloglobal/vendure-plugin-checkout-guard');
        expect(['paid', 'trial', 'free']).toContain(meta.tier);
        const settings = await (await fetch(`${BASE}/checkout-guard/settings`, { headers: { authorization: `Bearer ${token}` } })).json();
        expect(settings.bankTransfer).toEqual({ expiryDays: 7, reminderAfterDays: 3 });
        expect(settings.trustedClientIp.secretConfigured).toBe(true);
        expect(settings.rateLimits.applyCouponCode.capacity).toBe(3);
    });

    it('the Stripe webhook refuses unsigned and badly signed bodies', async () => {
        const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.amount_capturable_updated', data: { object: { id: 'pi_1', metadata: {} } } });
        const unsigned = await fetch(`${BASE}/checkout-guard/stripe-webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        expect(unsigned.status).toBe(400);
        const bad = await fetch(`${BASE}/checkout-guard/stripe-webhook`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': buildStripeSignatureHeader(body, 'whsec_wrong') }, body,
        });
        expect(bad.status).toBe(400);
        // Correctly signed but without Vendure metadata: acknowledged and ignored.
        const ok = await fetch(`${BASE}/checkout-guard/stripe-webhook`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': buildStripeSignatureHeader(body, WEBHOOK_SECRET) }, body,
        });
        expect(ok.status).toBe(200);
    });

    it('funnel + client-decline beacons record rows and are rate limited', async () => {
        const bad = await fetch(`${BASE}/checkout-guard/funnel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'nope' }) });
        expect(bad.status).toBe(400);
        for (const step of ['address', 'payment', 'pay_attempt']) {
            const res = await fetch(`${BASE}/checkout-guard/funnel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step, sessionId: 'sess-1', orderCode: 'ABC123' }) });
            expect(res.status).toBe(200);
        }
        const dec = await fetch(`${BASE}/checkout-guard/client-decline`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderCode: 'ABC123', code: 'card_declined', message: 'Your card was declined.' }) });
        expect(dec.status).toBe(200);
        const rows = await raw().query(`SELECT kind, code FROM checkout_guard_payment_event WHERE code = 'card_declined'`);
        expect(rows.length).toBeGreaterThanOrEqual(1);
        const funnel = await raw().query(`SELECT step FROM checkout_guard_funnel_event WHERE sessionId = 'sess-1'`);
        expect(funnel.map((r: any) => r.step).sort()).toEqual(['address', 'pay_attempt', 'payment']);
        // Summary reflects the beacons.
        const summary = await obs().funnelSummary(7);
        const addressStep: any = summary.steps.find((s: any) => s.step === 'address');
        expect(addressStep).toBeTruthy();
        expect(Number(addressStep.unique ?? addressStep.count ?? addressStep.events ?? 0)).toBeGreaterThanOrEqual(1);
    });

    // ── Bank transfer flow ─────────────────────────────────────────────
    it('bank transfer: authorised payment carries public details, expiry sweep cancels, received settles', async () => {
        await ensureCatalogue();
        const order = await startGuestOrder('bank.buyer@example.com');
        const paid = await shopClient.query(gql`mutation {
            addPaymentToOrder(input: { method: "bank-transfer", metadata: {} }) {
                ... on Order { id code state payments { id state method metadata } }
                ... on ErrorResult { errorCode message }
            }
        }`);
        expect(paid.addPaymentToOrder.state).toBe('PaymentAuthorized');
        const payment = paid.addPaymentToOrder.payments[0];
        expect(payment.state).toBe('Authorized');
        const pub = payment.metadata?.public;
        expect(pub.accountNumber).toBe('31138533');
        expect(pub.sortCode).toBe('04-06-05');
        expect(pub.reference).toBe(order.code);
        expect(pub.amountMinor).toBeGreaterThan(0);
        expect(new Date(pub.payBy).getTime()).toBeGreaterThan(Date.now());

        // Listing shows it as awaiting.
        const awaiting = await bank().list('awaiting', 30, 50);
        expect(awaiting.some((r: any) => r.orderCode === order.code)).toBe(true);

        // Sweep "now": nothing due yet.
        const early = await bank().sweep(new Date());
        expect(early.expired).toBe(0);
        expect(early.repaired).toBe(0);

        // Admin marks it received → settled, order PaymentSettled.
        const received = await bank().markReceived(num(payment.id));
        expect(received.ok).toBe(true);
        const [row] = await raw().query('SELECT state FROM `order` WHERE id = ?', [num(order.id)]);
        expect(row.state).toBe('PaymentSettled');
    });

    it('bank transfer: an unpaid order past the deadline is cancelled by the sweep', async () => {
        const order = await startGuestOrder('late.buyer@example.com');
        const paid = await shopClient.query(gql`mutation {
            addPaymentToOrder(input: { method: "bank-transfer", metadata: {} }) { ... on Order { id state payments { id } } ... on ErrorResult { errorCode message } }
        }`);
        expect(paid.addPaymentToOrder.state).toBe('PaymentAuthorized');
        const inTenDays = new Date(Date.now() + 10 * 24 * 3600_000);
        const result = await bank().sweep(inTenDays);
        expect(result.expired).toBeGreaterThanOrEqual(1);
        const [row] = await raw().query('SELECT state FROM `order` WHERE id = ?', [num(order.id)]);
        expect(row.state).toBe('Cancelled');
        const events = await raw().query(`SELECT kind FROM checkout_guard_payment_event WHERE kind = 'bank_expired' AND orderId = ?`, [num(order.id)]);
        expect(events.length).toBeGreaterThanOrEqual(1);
    });

    // ── Session-bound order lookup ─────────────────────────────────────
    it('orderByCode works for the placing session and is refused for a stranger', async () => {
        const order = await startGuestOrder('bound.buyer@example.com');
        const paid = await shopClient.query(gql`mutation {
            addPaymentToOrder(input: { method: "bank-transfer", metadata: {} }) { ... on Order { code } ... on ErrorResult { errorCode message } }
        }`);
        expect(paid.addPaymentToOrder.code).toBe(order.code);
        const [stored] = await raw().query('SELECT customFieldsCgsessionhash AS h FROM `order` WHERE id = ?', [num(order.id)]);
        expect(String(stored.h || '')).toHaveLength(64);

        const mine = await shopClient.query(gql`query ($code: String!) { orderByCode(code: $code) { code state } }`, { code: order.code });
        expect(mine.orderByCode.code).toBe(order.code);

        // A brand-new anonymous session (plain fetch, no token) with the same code is refused.
        const stranger = await (await fetch(`${BASE}/shop-api`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: `query { orderByCode(code: "${order.code}") { code } }` }),
        })).json();
        expect(stranger.data?.orderByCode ?? null).toBeNull();
        expect(JSON.stringify(stranger.errors || [])).toMatch(/FORBIDDEN|authorized|permission/i);
    });

    // ── Guards: trusted IP + rate limit ────────────────────────────────
    it('strips the forwarded client IP unless the proxy secret is present', async () => {
        const seen = await raw().query('SELECT 1');
        expect(seen).toBeTruthy();
        // The funnel beacon stores the resolved IP; compare with and without the secret.
        await fetch(`${BASE}/checkout-guard/funnel`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-client-ip': '198.51.100.7' }, body: JSON.stringify({ step: 'cart', sessionId: 'ip-no-secret' }) });
        await fetch(`${BASE}/checkout-guard/funnel`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-client-ip': '198.51.100.8', 'x-checkout-guard-proxy': PROXY_SECRET }, body: JSON.stringify({ step: 'cart', sessionId: 'ip-with-secret' }) });
        const [noSecret] = await raw().query(`SELECT ip FROM checkout_guard_funnel_event WHERE sessionId = 'ip-no-secret'`);
        const [withSecret] = await raw().query(`SELECT ip FROM checkout_guard_funnel_event WHERE sessionId = 'ip-with-secret'`);
        expect(noSecret.ip).not.toBe('198.51.100.7');
        expect(withSecret.ip).toBe('198.51.100.8');
    });

    it('rate-limits applyCouponCode per client IP', async () => {
        await startGuestOrder('coupon.spammer@example.com');
        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) {
            const res = await fetch(`${BASE}/shop-api`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${(shopClient as any).authToken}` },
                body: JSON.stringify({ query: 'mutation { applyCouponCode(couponCode: "NOPE") { ... on Order { id } ... on ErrorResult { errorCode } } }' }),
            });
            statuses.push(res.status);
        }
        expect(statuses.slice(0, 3).every(s => s === 200)).toBe(true);
        expect(statuses.slice(3)).toContain(429);
    });

    describe('rate limits cannot be sidestepped', () => {
        const COUPON = 'applyCouponCode(couponCode: "NOPE") { ... on Order { id } ... on ErrorResult { errorCode } }';
        let ipSeq = 10;
        /** POSTs as a fresh client IP (via the trusted proxy header), returns status + parsed JSON. */
        async function post(path: string, body: unknown, ip: string, extra: Record<string, string> = {}) {
            const res = await fetch(`${BASE}${path}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json', authorization: `Bearer ${(shopClient as any).authToken}`,
                    'x-real-client-ip': ip, 'x-checkout-guard-proxy': PROXY_SECRET, ...extra,
                },
                body: JSON.stringify(body),
            });
            let json: any = null;
            try { json = await res.json(); } catch { /* not JSON */ }
            return { status: res.status, json };
        }
        const freshIp = () => `198.51.100.${ipSeq++}`;
        /** How many applyCouponCode resolver executions a response shows. */
        const executed = (json: any): number => {
            const items = Array.isArray(json) ? json : [json];
            let n = 0;
            for (const it of items) for (const v of Object.values(it?.data || {})) if (v) n++;
            return n;
        };

        beforeAll(async () => { await ensureCatalogue(); await startGuestOrder('bypass.probe@example.com'); });

        it('aliased copies in one document each spend a token', async () => {
            const ip = freshIp();
            const doc = `mutation { ${Array.from({ length: 8 }, (_, i) => `a${i}: ${COUPON}`).join(' ')} }`;
            const r = await post('/shop-api', { query: doc }, ip);
            expect(r.status === 429 || executed(r.json) <= 3).toBe(true);
        });

        it('a batched array spends a token per operation', async () => {
            const ip = freshIp();
            const body = Array.from({ length: 8 }, () => ({ query: `mutation { ${COUPON} }` }));
            const r = await post('/shop-api', body, ip);
            expect(r.status === 429 || executed(r.json) <= 3).toBe(true);
        });

        it.each(['/SHOP-API', '/Shop-Api', '/shop-api/', '/shop-api?x=1'])('the Shop API reached as %s is limited too', async path => {
            const ip = freshIp();
            const statuses: number[] = [];
            let ran = 0;
            for (let i = 0; i < 5; i++) {
                const r = await post(path, { query: `mutation { ${COUPON} }` }, ip);
                statuses.push(r.status);
                if (r.status === 200) ran += executed(r.json);
            }
            expect(ran).toBeLessThanOrEqual(3);
        });

        it('an automatic persisted query (hash only, no document) is limited too', async () => {
            const { createHash } = await import('crypto');
            const doc = `mutation { ${COUPON} }`;
            const sha256Hash = createHash('sha256').update(doc).digest('hex');
            const ext = { persistedQuery: { version: 1, sha256Hash } };
            const ip = freshIp();
            // Register the document once, then replay by hash.
            await post('/shop-api', { query: doc, extensions: ext }, ip);
            let ran = 1;
            for (let i = 0; i < 5; i++) {
                const r = await post('/shop-api', { extensions: ext }, ip);
                if (r.status === 200) ran += executed(r.json);
            }
            expect(ran).toBeLessThanOrEqual(3);
        });

        it('APQ clients keep working: an unseen hash asks for the document, then the hash alone is served', async () => {
            const { createHash } = await import('crypto');
            const doc = 'query { activeChannel { code } }';
            const ext = { persistedQuery: { version: 1, sha256Hash: createHash('sha256').update(doc).digest('hex') } };
            const ip = freshIp();
            const first = await post('/shop-api', { extensions: ext }, ip);
            expect(first.json?.errors?.[0]?.extensions?.code).toBe('PERSISTED_QUERY_NOT_FOUND');
            const reg = await post('/shop-api', { query: doc, extensions: ext }, ip);
            expect(reg.json?.data?.activeChannel?.code).toBeTruthy();
            const replay = await post('/shop-api', { extensions: ext }, ip);
            expect(replay.json?.data?.activeChannel?.code).toBe(reg.json.data.activeChannel.code);
        });

        it('a spoofed X-Forwarded-For does not choose the rate-limit bucket', async () => {
            const statuses: number[] = [];
            for (let i = 0; i < 6; i++) {
                const res = await fetch(`${BASE}/shop-api`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${(shopClient as any).authToken}`, 'x-forwarded-for': `203.0.113.${100 + i}` },
                    body: JSON.stringify({ query: `mutation { ${COUPON} }` }),
                });
                statuses.push(res.status);
            }
            expect(statuses).toContain(429);
        });
    });

    // ── Observability service ──────────────────────────────────────────
    it('countRecentFailures counts declines by IP for the fraud plugin', async () => {
        await obs().recordPaymentEvent({ channelId: 1, kind: 'failed', provider: 'stripe', ip: '203.0.113.99', code: 'card_declined' } as any);
        await obs().recordPaymentEvent({ channelId: 1, kind: 'client_declined', provider: 'stripe', ip: '203.0.113.99', code: 'card_declined' } as any);
        expect(await obs().countRecentFailures('203.0.113.99', 60)).toBe(2);
        expect(await obs().countRecentFailures('203.0.113.1', 60)).toBe(0);
        const summary = await obs().summary();
        expect(summary).toHaveProperty('failed7d');
    });

    it('holds listing answers for an admin', async () => {
        await adminClient.asSuperAdmin();
        const token = (adminClient as any).authToken as string;
        const res = await fetch(`${BASE}/checkout-guard/holds`, { headers: { authorization: `Bearer ${token}` } });
        expect(res.status).toBe(200);
        const list = await res.json();
        expect(Array.isArray(list.items)).toBe(true);
        expect(list.premium).toBe(true);
    });
});
