import type { StripeBankTransferSettings } from './stripe-bank-transfer';

/**
 * Runtime settings for the bank-transfer module.
 *
 * The plugin class (`src/plugin.ts`) owns the options object and the licence
 * state. This module never imports the plugin class (that would be a circular
 * import between the handler, the cron and the plugin), so the plugin pushes
 * the values the module needs here from `CheckoutGuardPlugin.init()` and again
 * at bootstrap, once the ops service exists:
 *
 * ```ts
 * setBankTransferRuntime({
 *     expiryDays: options.bankTransfer?.expiryDays,
 *     reminderAfterDays: options.bankTransfer?.reminderAfterDays,
 *     hasPremiumAccess: () => CheckoutGuardPlugin.hasPremiumAccess(),
 *     stripe: normaliseStripeBankTransferOptions(options.bankTransfer?.stripe),
 *     notifyOps: ev => opsAlertService.alert(ev),
 * });
 * ```
 *
 * Defaults are safe when nothing has been set: 7-day expiry, 3-day reminder,
 * premium access reported as false (so the sweep is a logged no-op), Stripe
 * bank transfers off and no ops alerts.
 */
export interface BankTransferRuntime {
    /** Days after the payment is created before an unpaid transfer expires. Default 7. */
    expiryDays: number;
    /** Days after the payment is created before the reminder event fires. Default 3. */
    reminderAfterDays: number;
    /** Auto-expiry + reminders are premium features; the sweep is a no-op when this returns false. */
    hasPremiumAccess: () => boolean;
    /** Validated `bankTransfer.stripe` options; null while Stripe bank transfers are off (the default). */
    stripe: StripeBankTransferSettings | null;
    /** Ops fan-out (the plugin's OpsAlertService). Must never throw; callers use `notifyBankTransferOps`. */
    notifyOps: (ev: BankTransferOpsEvent) => Promise<void>;
}

/**
 * Alerts raised by Stripe bank transfers. All of them are delivered on every
 * tier (see `ALWAYS_ALERT` in the ops-alert service): Stripe bank transfers
 * are a free-tier feature, and each of these means money or a customer that
 * needs a human.
 */
export type BankTransferOpsEventName =
    /** Checkout fell back to the payment method's own details (settle by hand). */
    | 'bank.stripe_fallback'
    /** A PaymentIntent could not be cancelled, or may exist without Checkout Guard knowing its id. */
    | 'bank.stripe_cancel_failed'
    /** Money is at Stripe but no order was settled with it (refund or reconcile). */
    | 'bank.stripe_unsettled'
    /** A part-paid transfer was cancelled: the part payment is back in the customer's cash balance. */
    | 'bank.stripe_partially_funded'
    /** Stripe could not be asked about an overdue transfer for a day, so it is not being expired. */
    | 'bank.stripe_check_failed';

export interface BankTransferOpsEvent {
    event: BankTransferOpsEventName;
    text: string;
    orderCode?: string;
    paymentIntentId?: string;
    amountMinor?: number;
    currency?: string;
    channelId?: number | string;
    provider?: string;
}

export const DEFAULT_BANK_TRANSFER_EXPIRY_DAYS = 7;
export const DEFAULT_BANK_TRANSFER_REMINDER_AFTER_DAYS = 3;

const noopNotify = async () => undefined;

let runtime: BankTransferRuntime = {
    expiryDays: DEFAULT_BANK_TRANSFER_EXPIRY_DAYS,
    reminderAfterDays: DEFAULT_BANK_TRANSFER_REMINDER_AFTER_DAYS,
    hasPremiumAccess: () => false,
    stripe: null,
    notifyOps: noopNotify,
};

function positiveIntOr(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function setBankTransferRuntime(next: Partial<BankTransferRuntime>): void {
    runtime = {
        expiryDays: positiveIntOr(next.expiryDays, DEFAULT_BANK_TRANSFER_EXPIRY_DAYS),
        reminderAfterDays: positiveIntOr(next.reminderAfterDays, DEFAULT_BANK_TRANSFER_REMINDER_AFTER_DAYS),
        hasPremiumAccess: typeof next.hasPremiumAccess === 'function' ? next.hasPremiumAccess : runtime.hasPremiumAccess,
        stripe: next.stripe ?? null,
        notifyOps: typeof next.notifyOps === 'function' ? next.notifyOps : runtime.notifyOps,
    };
}

export function getBankTransferRuntime(): BankTransferRuntime {
    return runtime;
}

/** Fire-and-forget ops alert: never throws, never delays a payment flow. */
export function notifyBankTransferOps(ev: BankTransferOpsEvent): void {
    try {
        void runtime.notifyOps(ev).catch(() => undefined);
    } catch { /* never propagate */ }
}
