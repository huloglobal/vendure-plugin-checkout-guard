import { ID } from '@vendure/core';

/**
 * Stripe-hold module — runtime contract.
 *
 * The module is deliberately decoupled from `plugin.ts`: the handler is
 * built at module load (Vendure needs it inside `configuration`), before
 * the plugin's `init()` runs, so it cannot read options through DI. The
 * plugin calls `configureStripeHold()` once (from `init()` /
 * `onApplicationBootstrap`) with the option accessor, the premium gate,
 * the ops fan-out and the payment-event recorder. Until it does, every
 * hook is a safe no-op and premium is treated as locked.
 */

export interface StripeHoldOptions {
    /** Signing secret of the Stripe webhook endpoint that targets
     *  `/checkout-guard/stripe-webhook`. Per-channel override via env
     *  `STRIPE_CG_WEBHOOK_SECRET_<CHANNELCODE>` (code upper-cased,
     *  non-alphanumerics replaced by `_`). */
    webhookSecret?: string;
    /** Code of the PaymentMethod (per channel) that hold payments are
     *  added to. When a channel has one method using the `stripe-hold`
     *  handler that method is picked regardless; this only breaks ties.
     *  Default `'stripe-hold'`. */
    holdMethodCode?: string;
    /** Authorised holds older than this many days are captured by the
     *  hourly safety cron (Stripe card authorisations lapse at 7 days).
     *  Default 6. */
    safetyCaptureDays?: number;
    /** When set, holds whose amount (Vendure minor units) is below this
     *  value are captured immediately from the webhook instead of
     *  waiting for review. */
    autoCaptureBelowMinor?: number;
}

export type StripeHoldEventKind = 'failed' | 'hold_expired';

/** Shape handed to the observability module (`checkout_guard_payment_event`). */
export interface StripeHoldPaymentEvent {
    kind: StripeHoldEventKind;
    provider: 'stripe';
    channelId?: ID;
    orderId?: ID;
    orderCode?: string;
    providerRef?: string;
    code?: string;
    message?: string;
    amountMinor?: number;
    currency?: string;
}

export type StripeHoldOpsEventName =
    | 'hold.authorized'
    | 'hold.captured'
    | 'hold.cancelled'
    | 'hold.auto_captured'
    | 'hold.safety_captured'
    | 'hold.capture_failed'
    | 'hold.cancel_failed'
    | 'hold.expired'
    | 'hold.amount_mismatch'
    | 'hold.webhook_error'
    | 'payment.failed';

export interface StripeHoldOpsEvent {
    event: StripeHoldOpsEventName;
    text: string;
    orderCode?: string;
    paymentIntentId?: string;
    amountMinor?: number;
    currency?: string;
    channelCode?: string;
}

export interface StripeHoldRuntime {
    /** Effective `options.stripe` block. */
    getOptions(): StripeHoldOptions;
    /** `CheckoutGuardPlugin.hasPremiumAccess()`. */
    hasPremiumAccess(): boolean;
    /** Ops fan-out (Slack/Discord/Teams/Telegram/webhook/email). Must never throw. */
    notifyOps(ev: StripeHoldOpsEvent): Promise<void>;
    /** Persist a payment event (module D). Must never throw. */
    recordPaymentEvent(ev: StripeHoldPaymentEvent): Promise<void>;
    /**
     * While premium is locked, answer 200 (instead of 503) for webhook events
     * about PaymentIntents that are not holds (any `capture_method` other than
     * `manual`). The plugin turns this on with Stripe bank transfers: their
     * endpoint also receives `payment_intent.succeeded` for every card payment,
     * and days of 503s could get it disabled. Off by default (0.2.9 behaviour).
     */
    acknowledgeNonHoldEventsWhileLocked?(): boolean;
}

export const STRIPE_HOLD_DEFAULTS = Object.freeze({
    holdMethodCode: 'stripe-hold',
    safetyCaptureDays: 6,
});

const noopRuntime: StripeHoldRuntime = {
    getOptions: () => ({}),
    hasPremiumAccess: () => false,
    notifyOps: async () => undefined,
    recordPaymentEvent: async () => undefined,
    acknowledgeNonHoldEventsWhileLocked: () => false,
};

let runtime: StripeHoldRuntime = noopRuntime;

/** Install the host plugin's accessors. Partial: anything omitted keeps
 *  its no-op default. Safe to call more than once. */
export function configureStripeHold(rt: Partial<StripeHoldRuntime>): void {
    runtime = { ...noopRuntime, ...runtime, ...rt };
}

export function getStripeHoldRuntime(): StripeHoldRuntime {
    return runtime;
}

/** Options with defaults applied and bad values clamped. */
export function effectiveStripeHoldOptions(): Required<Pick<StripeHoldOptions, 'holdMethodCode' | 'safetyCaptureDays'>> & StripeHoldOptions {
    const o = runtime.getOptions() || {};
    const days = Number(o.safetyCaptureDays);
    return {
        ...o,
        holdMethodCode: (o.holdMethodCode || STRIPE_HOLD_DEFAULTS.holdMethodCode).trim(),
        safetyCaptureDays: Number.isFinite(days) && days > 0 ? Math.min(days, 7) : STRIPE_HOLD_DEFAULTS.safetyCaptureDays,
    };
}

/** Fire-and-forget wrappers: hooks are never allowed to break payment flow. */
export async function notifyOpsSafe(ev: StripeHoldOpsEvent): Promise<void> {
    try { await runtime.notifyOps(ev); } catch { /* never propagate */ }
}
export async function recordPaymentEventSafe(ev: StripeHoldPaymentEvent): Promise<void> {
    try { await runtime.recordPaymentEvent(ev); } catch { /* never propagate */ }
}
