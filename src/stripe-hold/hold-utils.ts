/**
 * Pure helpers for the Stripe-hold module. No Vendure imports beyond
 * types so they stay unit-testable.
 */

export const STRIPE_HOLD_HANDLER_CODE = 'stripe-hold';
export const STRIPE_API_VERSION = '2022-11-15';

const DAY_MS = 86_400_000;

/** Metadata Vendure's StripePlugin stamps on every PaymentIntent. */
export interface VendureStripeMetadata {
    channelToken: string;
    orderCode: string;
    orderId: string;
    languageCode?: string;
}

/** Same rule as `isExpectedVendureStripeEventMetadata` in @vendure/payments-plugin. */
export function parseVendureMetadata(metadata: unknown): VendureStripeMetadata | null {
    if (!metadata || typeof metadata !== 'object') return null;
    const m = metadata as Record<string, unknown>;
    const channelToken = typeof m.channelToken === 'string' ? m.channelToken.trim() : '';
    const orderCode = typeof m.orderCode === 'string' ? m.orderCode.trim() : '';
    const orderIdRaw = m.orderId;
    const orderId = typeof orderIdRaw === 'string' ? orderIdRaw.trim()
        : typeof orderIdRaw === 'number' ? String(orderIdRaw) : '';
    if (!channelToken || !orderCode || !orderId) return null;
    const languageCode = typeof m.languageCode === 'string' && m.languageCode ? m.languageCode : undefined;
    return { channelToken, orderCode, orderId, languageCode };
}

/** Env name for a channel-specific webhook secret: `STRIPE_CG_WEBHOOK_SECRET_<CODE>`. */
export function webhookSecretEnvName(channelCode: string): string {
    const norm = String(channelCode || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return `STRIPE_CG_WEBHOOK_SECRET_${norm || 'DEFAULT'}`;
}

/** Channel env override first, then the plugin option. */
export function resolveWebhookSecret(
    channelCode: string | undefined,
    optionSecret: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
): string | undefined {
    if (channelCode) {
        const v = env[webhookSecretEnvName(channelCode)];
        if (v && v.trim()) return v.trim();
    }
    const o = (optionSecret || '').trim();
    return o || undefined;
}

/**
 * Every webhook signing secret configured: the plugin option first, then each
 * `STRIPE_CG_WEBHOOK_SECRET_<CHANNELCODE>` env value, without duplicates. Used
 * only when an event cannot be verified with the secret its channel selects
 * (one URL serving endpoints on several Stripe accounts).
 */
export function allWebhookSecrets(optionSecret: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
    const out: string[] = [];
    const add = (v: unknown) => {
        const s = typeof v === 'string' ? v.trim() : '';
        if (s && !out.includes(s)) out.push(s);
    };
    add(optionSecret);
    for (const name of Object.keys(env).sort()) {
        if (/^STRIPE_CG_WEBHOOK_SECRET_[A-Z0-9_]+$/.test(name)) add(env[name]);
    }
    return out;
}

let fractionCache: Record<string, boolean> = {};
/** Stripe zero-decimal currency detection, same approach as the Vendure
 *  Stripe plugin (Intl formatToParts). */
export function currencyHasFractionPart(currencyCode: string): boolean {
    const code = String(currencyCode || '').toUpperCase();
    if (code in fractionCache) return fractionCache[code];
    let result = true;
    try {
        const parts = new Intl.NumberFormat(undefined, {
            style: 'currency', currency: code, currencyDisplay: 'symbol',
        }).formatToParts(123.45);
        result = parts.some(p => p.type === 'fraction');
    } catch {
        result = true;
    }
    fractionCache[code] = result;
    return result;
}
/** Test hook. */
export function _resetCurrencyCache(): void { fractionCache = {}; }

/** Vendure minor units (always ×100) → Stripe minor units. */
export function toStripeMinorUnits(vendureAmount: number, currencyCode: string): number {
    return currencyHasFractionPart(currencyCode) ? Math.round(vendureAmount) : Math.round(vendureAmount / 100);
}
/** Stripe minor units → Vendure minor units. */
export function fromStripeMinorUnits(stripeAmount: number, currencyCode: string): number {
    return currencyHasFractionPart(currencyCode) ? Math.round(stripeAmount) : Math.round(stripeAmount) * 100;
}

/** When the safety cron will capture a hold authorised at `authorisedAt`. */
export function computeHoldUntil(authorisedAt: Date, safetyCaptureDays: number): Date {
    const days = Number.isFinite(safetyCaptureDays) && safetyCaptureDays > 0 ? safetyCaptureDays : 6;
    return new Date(authorisedAt.getTime() + days * DAY_MS);
}

/** True once a hold is due for safety capture. */
export function isHoldDue(authorisedAt: Date, safetyCaptureDays: number, now: Date = new Date()): boolean {
    return computeHoldUntil(authorisedAt, safetyCaptureDays).getTime() <= now.getTime();
}

/** Read `holdUntil` off payment metadata (public block preferred). */
export function holdUntilFromMetadata(metadata: any): Date | null {
    const raw = metadata?.public?.holdUntil ?? metadata?.holdUntil;
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function isPaymentIntentId(id: unknown): id is string {
    return typeof id === 'string' && /^pi_[A-Za-z0-9]+$/.test(id);
}

/** Deterministic idempotency keys so Stripe dedupes retried calls. */
/** Keys carry a minute bucket: retries inside a minute are deduped by
 *  Stripe, while a later attempt after a failure gets a fresh key (Stripe
 *  replays the original *error* for 24h under the same key). */
export function captureIdempotencyKey(paymentIntentId: string, at: Date = new Date()): string {
    return `cg-capture-${paymentIntentId}-${Math.floor(at.getTime() / 60_000)}`;
}
export function cancelIdempotencyKey(paymentIntentId: string, at: Date = new Date()): string {
    return `cg-cancel-${paymentIntentId}-${Math.floor(at.getTime() / 60_000)}`;
}
export function refundIdempotencyKey(paymentIntentId: string, amount: number, nonce: string): string {
    return `cg-refund-${paymentIntentId}-${amount}-${nonce}`;
}

/** Human amount for alerts, e.g. "£1,234.00". Never throws. */
export function formatMinor(amountMinor: number, currencyCode: string): string {
    try {
        const major = currencyHasFractionPart(currencyCode) ? amountMinor / 100 : amountMinor;
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currencyCode.toUpperCase() }).format(major);
    } catch {
        return `${amountMinor} ${currencyCode}`;
    }
}
