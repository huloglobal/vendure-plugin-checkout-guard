import { STRIPE_API_VERSION } from './hold-utils';

/**
 * Minimal Stripe REST client on the platform `fetch` (Node 18+). No SDK
 * dependency: the module only needs capture / cancel / refund / retrieve.
 * Requests are form-encoded like the SDK does, nested objects become
 * `a[b]=c`, arrays `a[0]=x`.
 */

export interface StripeApiError {
    type?: string;
    code?: string;
    decline_code?: string;
    message?: string;
    param?: string;
    payment_intent?: { id?: string; status?: string };
}

export class StripeRequestError extends Error {
    constructor(
        public readonly status: number,
        public readonly error: StripeApiError,
        public readonly path: string,
    ) {
        super(error?.message || `Stripe ${path} returned HTTP ${status}`);
        this.name = 'StripeRequestError';
    }
    get code(): string | undefined { return this.error?.code; }
    get type(): string | undefined { return this.error?.type; }
}

export type FetchLike = (url: string, init: any) => Promise<{
    ok: boolean; status: number; json(): Promise<any>; text(): Promise<string>;
    headers?: { get(name: string): string | null } | null;
}>;

export interface StripeRequestOptions {
    idempotencyKey?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    apiVersion?: string;
    baseUrl?: string;
    /** Called once Stripe has answered (before the body is checked). `replayed` is Stripe's
     *  `Idempotent-Replayed: true` header: the saved answer to an earlier request with the same key. */
    onResponse?: (info: { status: number; replayed: boolean }) => void;
}

export function encodeForm(params: Record<string, unknown>, prefix = ''): string {
    const pairs: string[] = [];
    const walk = (value: unknown, key: string) => {
        if (value === undefined || value === null) return;
        if (Array.isArray(value)) {
            value.forEach((v, i) => walk(v, `${key}[${i}]`));
        } else if (typeof value === 'object') {
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                walk(v, key ? `${key}[${k}]` : k);
            }
        } else {
            pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
        }
    };
    walk(params, prefix);
    return pairs.join('&');
}

export async function stripeRequest<T = any>(
    apiKey: string,
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, unknown> = {},
    opts: StripeRequestOptions = {},
): Promise<T> {
    if (!apiKey) throw new Error('Stripe API key missing');
    const fetchImpl: FetchLike = opts.fetchImpl || ((globalThis as any).fetch as FetchLike);
    if (typeof fetchImpl !== 'function') throw new Error('Platform fetch is not available (Node 18+ required)');
    const base = (opts.baseUrl || 'https://api.stripe.com').replace(/\/+$/, '');
    const cleanPath = path.replace(/^\/+/, '');
    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Stripe-Version': opts.apiVersion || STRIPE_API_VERSION,
    };
    let url = `${base}/${cleanPath}`;
    let body: string | undefined;
    const encoded = encodeForm(params);
    if (method === 'GET') {
        if (encoded) url += (url.includes('?') ? '&' : '?') + encoded;
    } else {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = encoded;
        if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    }
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = ac ? setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000) : undefined;
    try {
        const res = await fetchImpl(url, { method, headers, body, signal: ac?.signal });
        if (opts.onResponse) {
            let replayed = false;
            try { replayed = String(res.headers?.get?.('idempotent-replayed') ?? '').toLowerCase() === 'true'; } catch { /* no headers */ }
            opts.onResponse({ status: res.status, replayed });
        }
        let payload: any = null;
        try { payload = await res.json(); } catch { payload = null; }
        if (!res.ok) {
            throw new StripeRequestError(res.status, (payload && payload.error) || { message: `HTTP ${res.status}` }, cleanPath);
        }
        return payload as T;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export interface StripePaymentIntentLike {
    id: string;
    status: string;
    amount: number;
    amount_capturable?: number;
    amount_received?: number;
    currency: string;
    capture_method?: 'automatic' | 'manual' | string;
    metadata?: Record<string, string>;
    last_payment_error?: { code?: string; decline_code?: string; message?: string; type?: string } | null;
    latest_charge?: string | { id: string } | null;
    canceled_at?: number | null;
    created?: number;
}

export function retrievePaymentIntent(apiKey: string, id: string, opts: StripeRequestOptions = {}): Promise<StripePaymentIntentLike> {
    return stripeRequest(apiKey, 'GET', `v1/payment_intents/${encodeURIComponent(id)}`, {}, opts);
}

export function capturePaymentIntent(
    apiKey: string, id: string, params: { amount_to_capture?: number } = {}, opts: StripeRequestOptions = {},
): Promise<StripePaymentIntentLike> {
    return stripeRequest(apiKey, 'POST', `v1/payment_intents/${encodeURIComponent(id)}/capture`, params, opts);
}

export function cancelPaymentIntent(
    apiKey: string, id: string, params: { cancellation_reason?: string } = {}, opts: StripeRequestOptions = {},
): Promise<StripePaymentIntentLike> {
    return stripeRequest(apiKey, 'POST', `v1/payment_intents/${encodeURIComponent(id)}/cancel`, params, opts);
}

export interface StripeRefundLike {
    id: string;
    status: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'requires_action' | string;
    amount: number;
    failure_reason?: string;
}

export function createStripeRefund(
    apiKey: string, params: { payment_intent: string; amount?: number; reason?: string }, opts: StripeRequestOptions = {},
): Promise<StripeRefundLike> {
    return stripeRequest(apiKey, 'POST', 'v1/refunds', params, opts);
}

/** Stripe's "already in that state" errors for capture/cancel. */
export function isUnexpectedStateError(e: unknown): e is StripeRequestError {
    return e instanceof StripeRequestError && (e.code === 'payment_intent_unexpected_state' || e.status === 400 && /already|cannot be (captured|canceled)|status of/i.test(e.message));
}
