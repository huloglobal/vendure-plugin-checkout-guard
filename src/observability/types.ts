/**
 * Shared shapes for the observability module (payment events, funnel
 * events, admin summaries). Kept free of Nest/Vendure imports so the
 * admin UI and host projects can import them as types.
 */

export const PAYMENT_EVENT_KINDS = [
    'failed',
    'client_declined',
    'orphan',
    'amount_drift',
    'hold_expired',
    'bank_expired',
] as const;
export type PaymentEventKind = typeof PAYMENT_EVENT_KINDS[number];

/** Kinds that only a licensed / trial install records. The free tier keeps
 *  declines (webhook `failed` and browser `client_declined`: the decline log
 *  the card-testing gate counts, free since 0.4.0) and bank-transfer expiries. */
export const PREMIUM_EVENT_KINDS: ReadonlySet<PaymentEventKind> = new Set<PaymentEventKind>([
    'orphan', 'amount_drift', 'hold_expired',
]);

export interface PaymentEventInput {
    /** Vendure channel id. Defaults to 1 (the default channel) when omitted. */
    channelId?: number | string | null;
    kind: PaymentEventKind;
    /** e.g. 'stripe', 'bank-transfer', 'storefront' */
    provider: string;
    orderId?: number | string | null;
    orderCode?: string | null;
    /** Provider-side reference — Stripe PaymentIntent id, order code for
     *  bank transfers. Used for de-duplication of orphan/drift rows. */
    providerRef?: string | null;
    /** Provider decline / error code (e.g. 'card_declined'). */
    code?: string | null;
    message?: string | null;
    amountMinor?: number | null;
    currency?: string | null;
    ip?: string | null;
}

export interface PaymentEventRow {
    id: number;
    channelId: number;
    orderId: number | null;
    orderCode: string | null;
    kind: PaymentEventKind;
    provider: string;
    providerRef: string | null;
    code: string | null;
    message: string | null;
    amountMinor: number | null;
    currency: string | null;
    ip: string | null;
    createdAt: string;
}

export const FUNNEL_STEPS = [
    'cart',
    'address',
    'payment',
    'pay_attempt',
    'pay_failed',
    'coupon_rejected',
    'placed',
] as const;
export type FunnelStep = typeof FUNNEL_STEPS[number];

/** The linear path a checkout follows; side events (pay_failed,
 *  coupon_rejected) are reported alongside but not in the drop-off chain. */
export const FUNNEL_CHAIN: readonly FunnelStep[] = ['cart', 'address', 'payment', 'pay_attempt', 'placed'];

export interface FunnelEventInput {
    channelId?: number | string | null;
    step: FunnelStep;
    orderCode?: string | null;
    sessionId?: string | null;
    detail?: string | null;
    ip?: string | null;
}

export interface FunnelStepSummary {
    step: FunnelStep;
    /** Raw event count. */
    events: number;
    /** Distinct checkouts (keyed on orderCode, then sessionId, then ip). */
    unique: number;
    /** % of the previous chain step's unique checkouts that did NOT reach
     *  this step. Null for the first step and for side events. */
    dropOffPct: number | null;
}

export interface FunnelSummary {
    days: number;
    steps: FunnelStepSummary[];
    /** Unique checkouts that reached `placed` / unique that reached the
     *  first populated chain step, as a percentage. */
    conversionPct: number | null;
    /** Largest single-step drop-off in the chain, as a percentage. */
    worstDropOffPct: number | null;
    worstDropOffStep: FunnelStep | null;
    /** pay_failed unique / pay_attempt unique, as a percentage. */
    paymentFailureRatePct: number | null;
    couponRejections: number;
}

/** Usage counters for one window (digest, heartbeat, evaluation, widget). */
export interface UsageStats {
    holdsPlaced: number;
    holdsCaptured: number;
    holdsCancelled: number;
    /** Minor units of the holds placed in the window. */
    heldValuePence: number;
    bankTransfersConfirmed: number;
    rateLimitRejections: number;
    orderAccessDenied: number;
    orphansFound: number;
    /** Payment attempts refused by the card-testing gate. */
    cardTestingBlocked: number;
    /** Currency of `heldValuePence` when every hold shares one; null when mixed or none. */
    heldCurrency: string | null;
}

export interface ObservabilitySummary {
    holdsPending: number;
    bankAwaiting: number;
    failed7d: number;
    clientDeclined7d: number;
    orphansOpen: number;
    drift30d: number;
    funnelDropOffPct: number | null;
    funnel: FunnelSummary;
    premium: boolean;
}

/** One Stripe PaymentIntent as returned by `GET /v1/payment_intents`
 *  (only the fields reconciliation reads). */
export interface StripeIntentLite {
    id: string;
    status: string;
    amount: number;
    /** Captured amount (succeeded intents). */
    amountReceived?: number | null;
    currency: string;
    created: number;
    metadata?: Record<string, string> | null;
    description?: string | null;
}

export interface OrphanCandidate {
    paymentIntentId: string;
    amountMinor: number;
    currency: string;
    createdAt: Date;
    orderCode: string | null;
    orderId: string | null;
    channelToken: string | null;
    status: string;
}
