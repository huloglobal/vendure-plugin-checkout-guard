import type { DigestStat, DigestTip } from '@huloglobal/vendure-licence-sdk';
import type { UsageStats } from './observability/types';

/**
 * Pure helpers behind the weekly report, the setup checklist, the
 * dashboard widget and the licence banner: what the numbers are called,
 * what the free tier loses, and which setup steps are still open. No I/O
 * here so every piece is unit-testable.
 */

export const SHORT_ID = 'vendure-plugin-checkout-guard';
export const PLUGIN_NAME = 'Checkout Guard';
export const ADMIN_ROUTE = 'checkout-guard';
export const BUY_URL = `https://elite.charity/licence/buy/${SHORT_ID}`;

/**
 * What a licence (or the 14-day evaluation) adds. Free since 0.4.0: the
 * Stripe hold list with capture and release, the decline log, the login
 * guard, shared limiter state, admin settings, the blocked list, the client
 * IP on the order, the automatic per-order card-testing gate and the
 * `orderByCode` lookup limit.
 */
export const PREMIUM_FEATURES: string[] = [
    'Auto-capture and the safety capture of Stripe holds',
    'HULO Payments for Vendure holds in the hold list',
    'Bank-transfer auto-expiry, reminders and customer e-mails',
    'Nightly reconciliation: orphaned charges and amount drift',
    'Amount-drift guard at settlement',
    'Ops alerts to Slack/Teams/Discord/Telegram/webhook/e-mail',
    'Weekly report and setup checklist',
];

/** The numeric keys reported to the licence server (heartbeat + evaluation). */
export const STAT_KEYS = [
    'holdsPlaced', 'holdsCaptured', 'holdsCancelled', 'heldValuePence',
    'bankTransfersConfirmed', 'rateLimitRejections', 'orderAccessDenied', 'orphansFound', 'cardTestingBlocked',
] as const;
export type StatKey = typeof STAT_KEYS[number];

/** Merchant-facing label per key, in the order the digest lists them. */
export const STAT_LABELS: Record<StatKey, { label: string; format: 'count' | 'pence' }> = {
    heldValuePence: { label: 'held on customers’ cards until you captured or released it', format: 'pence' },
    holdsPlaced: { label: 'Stripe holds placed', format: 'count' },
    holdsCaptured: { label: 'holds captured', format: 'count' },
    holdsCancelled: { label: 'holds released without charging', format: 'count' },
    bankTransfersConfirmed: { label: 'bank transfers confirmed', format: 'count' },
    rateLimitRejections: { label: 'abusive checkout requests rate-limited', format: 'count' },
    orderAccessDenied: { label: 'order lookups refused to the wrong session', format: 'count' },
    orphansFound: { label: 'orphaned Stripe charges found by reconciliation', format: 'count' },
    cardTestingBlocked: { label: 'card-testing attempts refused before reaching Stripe', format: 'count' },
};

/** Numbers only, for the stats providers (no currency, no PII). */
export function toStatRecord(s: UsageStats): Record<string, number> {
    const out: Record<string, number> = {};
    for (const k of STAT_KEYS) out[k] = Math.max(0, Math.round(Number(s[k]) || 0));
    return out;
}

/** Digest rows in display order, with the previous window for deltas. */
export function toDigestStats(current: UsageStats, previous?: UsageStats | null): DigestStat[] {
    return (Object.keys(STAT_LABELS) as StatKey[]).map(key => ({
        key,
        label: STAT_LABELS[key].label,
        format: STAT_LABELS[key].format,
        value: Math.max(0, Number(current[key]) || 0),
        previous: previous ? Math.max(0, Number(previous[key]) || 0) : null,
    }));
}

/** The top `n` non-zero stats, money first (it reads best), then counts by size. */
export function headlineStats(s: UsageStats, n: number = 3): DigestStat[] {
    const rows = toDigestStats(s).filter(r => r.value > 0);
    rows.sort((a, b) => (a.format === 'pence' ? -1 : b.format === 'pence' ? 1 : b.value - a.value));
    return rows.slice(0, n);
}

// ── Setup checklist ─────────────────────────────────────────────────

export interface SetupItem {
    key: string;
    label: string;
    done: boolean;
    hint: string;
    /** Admin page tab to switch to. */
    tab?: string;
    /** Admin-relative route (`/settings/...`) or absolute docs link. */
    url?: string;
}

export interface SetupFacts {
    publicBaseUrl: string;
    stripeWebhookSecretConfigured: boolean;
    /** Payment-method codes whose handler is `stripe-hold`. */
    holdMethodCodes: string[];
    /** Payment-method codes whose handler is `bank-transfer`. */
    bankMethodCodes: string[];
    trustedClientIpSecretConfigured: boolean;
    trustedProxiesConfigured: boolean;
    opsConfigured: boolean;
}

export function buildSetupItems(f: SetupFacts): { items: SetupItem[]; complete: boolean } {
    const base = (f.publicBaseUrl || '').replace(/\/+$/, '') || 'https://<publicBaseUrl>';
    const items: SetupItem[] = [
        {
            key: 'stripe-webhook',
            label: 'Stripe webhook signing secret',
            done: f.stripeWebhookSecretConfigured,
            hint: `Point a Stripe webhook at ${base}/checkout-guard/stripe-webhook for payment_intent.amount_capturable_updated, payment_failed and canceled, then set stripe.webhookSecret (or STRIPE_CG_WEBHOOK_SECRET_<CHANNELCODE>). Without it no hold is ever recorded.`,
            tab: 'settings',
        },
        {
            key: 'stripe-hold-method',
            label: 'A payment method with the stripe-hold handler',
            done: f.holdMethodCodes.length > 0,
            hint: 'Create a payment method per channel using the "Stripe hold" handler; it reads the channel’s Stripe key from the regular Stripe method.',
            url: '/settings/payment-methods',
        },
        {
            key: 'bank-transfer-method',
            label: 'A payment method with the bank-transfer handler',
            done: f.bankMethodCodes.length > 0,
            hint: 'Create a payment method with the "Bank transfer" handler and the bank-transfer-eligibility checker; the storefront shows the account details from payments[].metadata.public.',
            url: '/settings/payment-methods',
        },
        {
            key: 'trusted-client-ip',
            label: 'Trusted client IP for the storefront proxy',
            done: f.trustedClientIpSecretConfigured || f.trustedProxiesConfigured,
            hint: 'Set trustedClientIp.secret and have the storefront’s server-side proxy send x-real-client-ip with the x-checkout-guard-proxy header, or list the proxy in trustedClientIp.trustedProxies. Otherwise rate limits and the decline log key on the proxy’s address.',
            tab: 'settings',
        },
        {
            key: 'ops-channel',
            label: 'An ops alert channel',
            done: f.opsConfigured,
            hint: 'Connect Slack, Discord, Teams, Telegram, a signed webhook or ops.adminEmail + SMTP_* so orphaned charges, amount drift and failed captures reach a person.',
            tab: 'settings',
        },
    ];
    return { items, complete: items.every(i => i.done) };
}

/** Digest "next steps": the open checklist items, in order, at most three. */
export function setupTips(items: SetupItem[], adminUrl: string | null, max: number = 3): DigestTip[] {
    return items.filter(i => !i.done).slice(0, max).map(i => ({
        title: i.label,
        body: i.hint,
        url: adminUrl || undefined,
        linkLabel: adminUrl ? 'Open Checkout Guard' : undefined,
    }));
}
