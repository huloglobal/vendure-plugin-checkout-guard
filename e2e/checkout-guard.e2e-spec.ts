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
import { getCardTestingGate } from '../src/plugin';

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
                // 0.4.0 opt-in: the shopper's IP on the order (the e2e schema is synchronised).
                orderClientIp: true,
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
        // The expiry event is recorded by an EventBus subscriber, after the sweep's transaction: poll briefly.
        let events: any[] = [];
        for (let i = 0; i < 40 && !events.length; i++) {
            events = await raw().query(`SELECT kind FROM checkout_guard_payment_event WHERE kind = 'bank_expired' AND orderId = ?`, [num(order.id)]);
            if (!events.length) await new Promise(r => setTimeout(r, 100));
        }
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

    it('site errors and the gate own refusal are not counted as card declines', async () => {
        const ip = '203.0.113.77';
        const orderCode = 'NOTADECLINE1';
        for (const code of ['exception', 'intent_create_failed', 'exception']) {
            await obs().recordPaymentEvent({ channelId: 1, kind: 'client_declined', provider: 'stripe', ip, orderCode, code } as any);
        }
        expect(await obs().countRecentFailures(ip, 60)).toBe(0);
        expect(await obs().countRecentFailuresForOrder(orderCode, 60)).toBe(0);
        await obs().recordPaymentEvent({ channelId: 1, kind: 'client_declined', provider: 'stripe', ip, orderCode, code: 'card_declined' } as any);
        await obs().recordPaymentEvent({ channelId: 1, kind: 'client_declined', provider: 'stripe', ip, orderCode } as any);
        expect(await obs().countRecentFailures(ip, 60)).toBe(2);
        expect(await obs().countRecentFailuresForOrder(orderCode, 60)).toBe(2);
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

    // ── 0.4.0 parity wave ──────────────────────────────────────────────
    describe('0.4.0: admin settings, login guard, lookup limit, shared state, tiers', () => {
        let token = '';
        let ipSeq = 120;
        const nextIp = () => `198.51.100.${ipSeq++}`;
        async function admin(path: string, init: { method?: string; body?: unknown } = {}) {
            const res = await fetch(`${BASE}/checkout-guard/${path}`, {
                method: init.method || 'GET',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: init.body === undefined ? undefined : JSON.stringify(init.body),
            });
            let json: any = null;
            try { json = await res.json(); } catch { /* not JSON */ }
            return { status: res.status, json };
        }
        async function shopAs(ip: string, query: string, variables?: unknown) {
            const res = await fetch(`${BASE}/shop-api`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-real-client-ip': ip, 'x-checkout-guard-proxy': PROXY_SECRET },
                body: JSON.stringify({ query, variables }),
            });
            return { status: res.status, json: await res.json() };
        }
        const LOGIN = 'mutation { login(username: "nobody@example.com", password: "wrong") { ... on CurrentUser { id } ... on ErrorResult { errorCode message } } }';
        const LOOKUP = 'query { orderByCode(code: "NOPE") { id } }';

        beforeAll(async () => {
            await adminClient.asSuperAdmin();
            token = (adminClient as any).authToken as string;
        });
        afterAll(async () => { await admin('admin-settings/reset', { method: 'POST' }); });

        it('defaults change nothing: guards off, code values in force, anonymous callers refused', async () => {
            for (const p of ['admin-settings', 'blocked']) expect([401, 403]).toContain((await fetch(`${BASE}/checkout-guard/${p}`)).status);
            const s = await admin('admin-settings');
            expect(s.status).toBe(200);
            expect(s.json.editable).toBe(true);
            expect(s.json.saved).toEqual({});
            expect(s.json.effective.loginGuard.enabled).toBe(false);
            expect(s.json.effective.orderLookup.enabled).toBe(false);
            expect(s.json.effective.rateLimits.store).toBe('memory');
            expect(s.json.effective.cardTesting.autoOrderGate).toBe(false);
            expect(s.json.effective.bankTransfer).toEqual({ expiryDays: 7, reminderAfterDays: 3, emails: false });
            expect(s.json.effective.rateLimits.mutations.applyCouponCode).toEqual({ capacity: 3, windowMs: 60_000 });
            const ip = nextIp();
            for (let i = 0; i < 8; i++) {
                const r = await shopAs(ip, LOGIN);
                expect(r.json.data.login.errorCode).toBe('INVALID_CREDENTIALS_ERROR');
            }
        });

        it('rejects invalid settings with a field-named message', async () => {
            const bad = await admin('admin-settings', { method: 'POST', body: { settings: { loginGuard: { maxFailures: -1 } } } });
            expect(bad.status).toBe(400);
            expect(bad.json.message).toMatch(/loginGuard.maxFailures/);
        });

        it('login guard: locks a connection out, lists it as blocked, unblock lifts it', async () => {
            const saved = await admin('admin-settings', { method: 'POST', body: { settings: { loginGuard: { enabled: true, maxFailures: 2, windowMinutes: 15, apis: 'shop' } } } });
            expect(saved.status).toBe(200);
            expect(saved.json.effective.loginGuard).toEqual({ enabled: true, maxFailures: 2, windowMinutes: 15, apis: 'shop' });
            const ip = nextIp();
            expect((await shopAs(ip, LOGIN)).json.data.login.errorCode).toBe('INVALID_CREDENTIALS_ERROR');
            expect((await shopAs(ip, LOGIN)).json.data.login.errorCode).toBe('INVALID_CREDENTIALS_ERROR');
            await new Promise(r => setTimeout(r, 300));
            const refused = await shopAs(ip, LOGIN);
            expect(refused.json.errors?.[0]?.message).toMatch(/Too many failed login attempts/);
            expect(refused.json.errors?.[0]?.extensions?.code).toBe('RATE_LIMITED');
            // Another connection is unaffected.
            expect((await shopAs(nextIp(), LOGIN)).json.data.login.errorCode).toBe('INVALID_CREDENTIALS_ERROR');
            const blocked = await admin('blocked');
            expect(blocked.json.items.some((b: any) => b.ip === ip && b.surface === 'login:shop')).toBe(true);
            const un = await admin('blocked/unblock', { method: 'POST', body: { ip } });
            expect(un.status).toBe(200);
            expect((await shopAs(ip, LOGIN)).json.data.login.errorCode).toBe('INVALID_CREDENTIALS_ERROR');
            expect((await admin('blocked')).json.items.some((b: any) => b.ip === ip)).toBe(false);
        });

        it('orderByCode lookup limit (opt-in) answers RATE_LIMITED past the cap', async () => {
            await admin('admin-settings', { method: 'POST', body: { settings: { orderLookup: { enabled: true, capacity: 2, windowSeconds: 60 } } } });
            const ip = nextIp();
            expect((await shopAs(ip, LOOKUP)).json.errors?.[0]?.extensions?.code).not.toBe('RATE_LIMITED');
            expect((await shopAs(ip, LOOKUP)).json.errors?.[0]?.extensions?.code).not.toBe('RATE_LIMITED');
            const third = await shopAs(ip, LOOKUP);
            expect(third.json.errors?.[0]?.extensions?.code).toBe('RATE_LIMITED');
        });

        it('shared limiter store: database mode counts in cg_rate and still limits', async () => {
            const r = await admin('admin-settings', { method: 'POST', body: { settings: { rateLimits: { store: 'database' } } } });
            expect(r.json.effective.rateLimits.store).toBe('database');
            await raw().query('DELETE FROM cg_rate');
            await startGuestOrder('shared.store@example.com');
            const ip = nextIp();
            const statuses: number[] = [];
            for (let i = 0; i < 5; i++) {
                const res = await fetch(`${BASE}/shop-api`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${(shopClient as any).authToken}`, 'x-real-client-ip': ip, 'x-checkout-guard-proxy': PROXY_SECRET },
                    body: JSON.stringify({ query: 'mutation { applyCouponCode(couponCode: "NOPE") { ... on Order { id } ... on ErrorResult { errorCode } } }' }),
                });
                statuses.push(res.status);
            }
            expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
            expect(statuses.slice(3)).toEqual([429, 429]);
            const [row] = await raw().query('SELECT COUNT(*) AS n, MAX(n) AS top FROM cg_rate');
            expect(Number(row.n)).toBeGreaterThan(0);
            expect(Number(row.top)).toBe(5);
            const s = await admin('admin-settings');
            expect(s.json.limiterStoreInUse).toBe('database');
        });

        it('stores the shopper IP on the order at ArrangingPayment (opt-in orderClientIp)', async () => {
            const order = await startGuestOrder('client.ip@example.com');
            let ip: string | null = null;
            for (let i = 0; i < 20 && !ip; i++) {
                const [row] = await raw().query('SELECT customFieldsCgclientip AS ip FROM `order` WHERE id = ?', [num(order.id)]);
                ip = row?.ip ?? null;
                if (!ip) await new Promise(r => setTimeout(r, 100));
            }
            expect(ip).toBeTruthy();
            const s = await admin('admin-settings');
            expect(s.json.orderClientIpField).toBe('cgClientIp');
        });

        it('card-testing blocks are stored, listed and unblocked across the shared list', async () => {
            const gate = getCardTestingGate();
            const ip = '203.0.113.150';
            for (let i = 0; i < 4; i++) await obs().recordPaymentEvent({ channelId: 1, kind: 'failed', provider: 'stripe', ip, code: 'card_declined' } as any);
            expect((await gate.check(ip, 'createStripePaymentIntent')).blocked).toBe(true);
            await new Promise(r => setTimeout(r, 300));
            const listed = await admin('blocked');
            expect(listed.json.items.some((b: any) => b.ip === ip && b.surface === 'createStripePaymentIntent')).toBe(true);
            const [stored] = await raw().query('SELECT failures FROM cg_ip_block WHERE ip = ?', [ip]);
            expect(Number(stored.failures)).toBe(4);
            await admin('blocked/unblock', { method: 'POST', body: { ip } });
            expect((await gate.check(ip, 'createStripePaymentIntent')).blocked).toBe(false);
            expect((await admin('blocked/unblock', { method: 'POST', body: { ip: 'not-an-ip' } })).status).toBe(400);
        });

        it('free tier: hold capture/release never answer 402; checklist and weekly report preview are premium', async () => {
            configureStripeHold({ hasPremiumAccess: () => false });
            try {
                const cap = await admin('holds/999999/capture', { method: 'POST' });
                expect(cap.status).toBe(404);
                const rel = await admin('holds/999999/cancel', { method: 'POST' });
                expect(rel.status).toBe(404);
            } finally {
                configureStripeHold({ hasPremiumAccess: () => true });
            }
            // No licence and no reachable evaluation server in e2e: the install is on the free tier.
            const setup = await admin('setup');
            expect(setup.json).toEqual({ items: [], complete: true, premium: false });
            expect((await admin('digest/preview')).status).toBe(402);
            expect((await admin('digest/send-test', { method: 'POST', body: {} })).status).toBe(402);
            const digest = await admin('digest/settings');
            expect(digest.json.premium).toBe(false);
            expect(digest.json.nextDueAt).toBeNull();
        });

        it('0.5.0: e-mail appearance is saved, validated and previewed (admin only)', async () => {
            const anon = await fetch(`${BASE}/checkout-guard/email-preview?kind=reminder`);
            expect(anon.status).toBe(403);
            const bad = await admin('admin-settings', { method: 'POST', body: { settings: { email: { accentColor: 'red' } } } });
            expect(bad.status).toBe(400);
            const ok = await admin('admin-settings', { method: 'POST', body: { settings: { email: { storeName: 'E2E Shop', accentColor: '#ff0066', supportEmail: 'help@e2e.test' } } } });
            expect(ok.status).toBe(200);
            expect(ok.json.effective.email).toMatchObject({ storeName: 'E2E Shop', accentColor: '#ff0066', supportEmail: 'help@e2e.test' });
            const res = await fetch(`${BASE}/checkout-guard/email-preview?kind=reminder`, { headers: { authorization: `Bearer ${token}` } });
            expect(res.status).toBe(200);
            expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
            const html = await res.text();
            expect(html).toContain('E2E Shop');
            expect(html).toContain('border-bottom:3px solid #ff0066');
            expect(html).toContain('SAMPLE1234');
            const text = await fetch(`${BASE}/checkout-guard/email-preview?kind=alert&format=text`, { headers: { authorization: `Bearer ${token}` } });
            expect(await text.text()).toContain('Event: bank.stripe_unsettled');
            expect((await admin('email-preview?kind=nope')).status).toBe(400);
        });

        it('reset returns to the code options', async () => {
            const r = await admin('admin-settings/reset', { method: 'POST' });
            expect(r.status).toBe(200);
            expect(r.json.effective.loginGuard.enabled).toBe(false);
            expect(r.json.effective.rateLimits.store).toBe('memory');
            expect((await admin('admin-settings')).json.saved).toEqual({});
        });
    });
});

