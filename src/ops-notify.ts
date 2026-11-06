import { createHmac } from 'crypto';
import { Logger } from '@vendure/core';

const loggerCtx = 'CheckoutGuard';

/**
 * Ops-alert fan-out. Every configured channel gets the same event;
 * each transport is fire-and-forget with its own try/catch so one dead
 * webhook never silences the others.
 *
 * Channels (from `CheckoutGuardPluginOptions.ops`):
 *   slackWebhookUrl    — hooks.slack.com incoming webhook
 *   discordWebhookUrl  — discord.com/api/webhooks/…
 *   teamsWebhookUrl    — *.webhook.office.com incoming webhook
 *   telegramBotToken + telegramChatId
 *   genericWebhookUrl + genericWebhookSecret — POST JSON, HMAC-SHA256
 *     signature of the raw body in X-Hulo-Signature (hex)
 */
export interface OpsChannels {
    slackWebhookUrl?: string | null;
    discordWebhookUrl?: string | null;
    teamsWebhookUrl?: string | null;
    telegramBotToken?: string | null;
    telegramChatId?: string | null;
    genericWebhookUrl?: string | null;
    genericWebhookSecret?: string | null;
}

/** Event names raised by the plugin's modules. Hosts receiving the
 *  generic webhook can switch on `event`. */
export type CheckoutGuardOpsEventName =
    | 'payment.failed'
    | 'payment.orphan'
    | 'payment.amount_drift'
    | 'payment.client_declined'
    | 'payment.card_testing'
    | 'hold.authorised'
    | 'hold.captured'
    | 'hold.cancelled'
    | 'hold.safety_capture'
    | 'hold.expired'
    | 'bank.expired'
    | 'bank.reminder'
    | 'bank.stripe_fallback'
    | 'bank.stripe_cancel_failed'
    | 'bank.stripe_unsettled'
    | 'bank.stripe_partially_funded'
    | 'bank.stripe_check_failed'
    | 'webhook.error'
    | 'reconciliation.summary';

export interface OpsEvent {
    event: CheckoutGuardOpsEventName | (string & {});
    text: string;
    orderCode?: string;
    channelId?: number | string;
    provider?: string;
    providerRef?: string;
    /** Stripe PaymentIntent id, when the event concerns one. */
    paymentIntentId?: string;
    channelCode?: string;
    amountMinor?: number;
    currency?: string;
    detail?: Record<string, unknown>;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: typeof body === 'string' ? body : JSON.stringify(body),
            signal: controller.signal,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } finally {
        clearTimeout(t);
    }
}

export async function fanOutOpsEvent(channels: OpsChannels, ev: OpsEvent): Promise<void> {
    const jobs: Array<Promise<void>> = [];

    if (channels.slackWebhookUrl && /^https:\/\/hooks\.slack\.com\//.test(channels.slackWebhookUrl)) {
        jobs.push(post(channels.slackWebhookUrl, { text: ev.text }));
    }
    if (channels.discordWebhookUrl && /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(channels.discordWebhookUrl)) {
        // Discord rejects Slack-style markdown-ish asterisks less gracefully; send as-is, content max 2000
        jobs.push(post(channels.discordWebhookUrl, { content: ev.text.slice(0, 1990) }));
    }
    if (channels.teamsWebhookUrl && /^https:\/\/[\w.-]+\.webhook\.office\.com\//.test(channels.teamsWebhookUrl)) {
        jobs.push(post(channels.teamsWebhookUrl, { text: ev.text }));
    }
    if (channels.telegramBotToken && channels.telegramChatId
        && /^[0-9]+:[\w-]+$/.test(channels.telegramBotToken)) {
        jobs.push(post(
            `https://api.telegram.org/bot${channels.telegramBotToken}/sendMessage`,
            { chat_id: channels.telegramChatId, text: ev.text },
        ));
    }
    if (channels.genericWebhookUrl && /^https:\/\//.test(channels.genericWebhookUrl)) {
        const payload = JSON.stringify({ ...ev, ts: new Date().toISOString() });
        const headers: Record<string, string> = {};
        if (channels.genericWebhookSecret) {
            headers['X-Hulo-Signature'] = createHmac('sha256', channels.genericWebhookSecret)
                .update(payload).digest('hex');
        }
        jobs.push(post(channels.genericWebhookUrl, payload, headers));
    }

    const results = await Promise.allSettled(jobs);
    for (const r of results) {
        if (r.status === 'rejected') {
            Logger.warn(`Ops notification transport failed: ${r.reason?.message || r.reason}`, loggerCtx);
        }
    }
}
