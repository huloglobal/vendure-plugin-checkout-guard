import { Logger } from '@vendure/core';
import type { EmailBranding } from '../email/layout';

/**
 * Observability module — runtime contract.
 *
 * Like the stripe-hold and bank-transfer modules, this module never
 * imports `../plugin` (circular import). The plugin installs the option
 * accessor and the premium gate once from `CheckoutGuardPlugin.init()` /
 * `onApplicationBootstrap`:
 *
 * ```ts
 * configureObservability({
 *     getOptions: () => ({
 *         stripe: options.stripe,
 *         reconciliation: options.reconciliation,
 *         trustedClientIp: options.trustedClientIp,
 *         ops: options.ops,
 *     }),
 *     hasPremiumAccess: () => CheckoutGuardPlugin.hasPremiumAccess(),
 * });
 * ```
 *
 * Until it does, options are empty and premium is treated as locked, so
 * every premium path is a logged no-op.
 */
export const loggerCtx = 'CheckoutGuard';

export interface ObservabilityOpsOptions {
    slackWebhookUrl?: string;
    discordWebhookUrl?: string;
    teamsWebhookUrl?: string;
    telegramBotToken?: string;
    telegramChatId?: string;
    webhookUrl?: string;
    webhookSecret?: string;
    adminEmail?: string;
}

export interface ObservabilityOptions {
    stripe?: { holdMethodCode?: string };
    reconciliation?: { enabled?: boolean; lookbackDays?: number; amountDrift?: boolean };
    trustedClientIp?: { header?: string; secretHeader?: string; secret?: string; trustedProxies?: string[]; trustCloudflareHeader?: boolean };
    ops?: ObservabilityOpsOptions;
    /** The merchant's e-mail look (store name, accent, logo) for the ops alert e-mail. */
    email?: EmailBranding;
}

export interface ObservabilityRuntime {
    getOptions(): ObservabilityOptions;
    hasPremiumAccess(): boolean;
}

let runtime: ObservabilityRuntime = {
    getOptions: () => ({}),
    hasPremiumAccess: () => false,
};

/** Install the host plugin's accessors. Partial: anything omitted keeps
 *  its previous value. Safe to call more than once. */
export function configureObservability(rt: Partial<ObservabilityRuntime>): void {
    runtime = { ...runtime, ...rt };
}

export function runtimeOptions(): ObservabilityOptions {
    try {
        return runtime.getOptions() || {};
    } catch {
        return {};
    }
}

export function hasPremium(): boolean {
    try {
        return !!runtime.hasPremiumAccess();
    } catch {
        return false;
    }
}

const lockedNoticeShown = new Set<string>();

/** Log the "premium feature locked" notice once per feature, then stay quiet. */
export function noteLocked(feature: string): void {
    if (lockedNoticeShown.has(feature)) return;
    lockedNoticeShown.add(feature);
    Logger.info(`${feature} is a premium feature — add a licence key or start the 14-day trial to enable it.`, loggerCtx);
}

export const HOLD_METHOD_DEFAULT = 'stripe-hold';
export const BANK_METHOD_CODE = 'bank-transfer';

export function holdMethodCode(): string {
    return (runtimeOptions().stripe?.holdMethodCode || HOLD_METHOD_DEFAULT).trim();
}
