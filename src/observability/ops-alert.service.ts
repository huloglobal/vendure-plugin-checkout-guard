import { Injectable } from '@nestjs/common';
import { Logger } from '@vendure/core';
import { fanOutOpsEvent, OpsChannels, OpsEvent } from '../ops-notify';
import { hasPremium, loggerCtx, noteLocked, runtimeOptions } from './runtime';

/** Events delivered even on the free tier: the operator must hear that holds are not being recorded. */
const ALWAYS_ALERT = new Set(['hold.webhook_error', 'webhook.error']);

type SmtpSettings = { host: string; port: number; user: string; pass: string; from: string };

/**
 * One pooled transport per SMTP settings tuple, with timeouts (defaults are 2 min / 10 min).
 * Connect and greeting get 30 s: a server may hold its greeting while it checks the
 * sender's reverse DNS (Gmail has taken just over 5 s). The socket idle timer runs
 * during the greeting wait, so it must be longer, or a server that never greets fails
 * with a bare "Timeout" instead of "Greeting never received".
 */
let transportCache: { key: string; t: any } | null = null;
function transportFor(nodemailer: any, smtp: SmtpSettings): any {
    const key = [smtp.host, smtp.port, smtp.user, smtp.pass].join('|');
    if (transportCache?.key === key) return transportCache.t;
    try { transportCache?.t?.close?.(); } catch { /* ignore */ }
    const t = nodemailer.createTransport({
        host: smtp.host, port: smtp.port, secure: smtp.port === 465,
        auth: { user: smtp.user, pass: smtp.pass },
        pool: true, maxConnections: 2, maxMessages: 100,
        connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 45_000,
    });
    transportCache = { key, t };
    return t;
}

/**
 * Ops alerts (premium). Fans one event out to every configured chat
 * webhook (`options.ops`) and, when `ops.adminEmail` plus SMTP_* env are
 * present, e-mails it as well. Never throws: a dead webhook must not
 * break a payment flow.
 *
 * SMTP env (same names as the fraud-prevention plugin):
 *   SMTP_SERVER, SMTP_PORT (587), SMTP_USER, SMTP_PASSWORD, SMTP_FROM
 *
 * @docsCategory Services
 * @category Services
 */
@Injectable()
export class OpsAlertService {
    private channels(): OpsChannels {
        const ops = runtimeOptions().ops || {};
        return {
            slackWebhookUrl: ops.slackWebhookUrl || null,
            discordWebhookUrl: ops.discordWebhookUrl || null,
            teamsWebhookUrl: ops.teamsWebhookUrl || null,
            telegramBotToken: ops.telegramBotToken || null,
            telegramChatId: ops.telegramChatId || null,
            genericWebhookUrl: ops.webhookUrl || null,
            genericWebhookSecret: ops.webhookSecret || null,
        };
    }

    /** True when at least one transport is configured. */
    isConfigured(): boolean {
        const c = this.channels();
        return !!(c.slackWebhookUrl || c.discordWebhookUrl || c.teamsWebhookUrl
            || (c.telegramBotToken && c.telegramChatId) || c.genericWebhookUrl
            || (runtimeOptions().ops?.adminEmail && this.smtp()));
    }

    /**
     * Send an alert. Resolves once every transport has settled; callers
     * that must not wait should `void` the promise.
     */
    async alert(ev: OpsEvent): Promise<void> {
        // Licensing / webhook failures must still reach the operator when premium is locked.
        if (!hasPremium() && !ALWAYS_ALERT.has(ev.event)) {
            noteLocked('Ops alerts');
            return;
        }
        try {
            await Promise.allSettled([
                fanOutOpsEvent(this.channels(), ev),
                this.email(ev),
            ]);
        } catch (e: any) {
            Logger.warn(`Ops alert failed: ${e?.message || e}`, loggerCtx);
        }
    }

    /** True when `SMTP_SERVER` + `SMTP_USER` are present (the e-mail path can send). */
    hasSmtp(): boolean { return !!this.smtp(); }

    /** The merchant address ops e-mails go to (`ops.adminEmail`), or null. */
    adminEmail(): string | null { return (runtimeOptions().ops?.adminEmail || '').trim() || null; }

    /**
     * Send one plain message through the same pooled SMTP transport the
     * alerts use (weekly report, test sends). Throws when SMTP or
     * nodemailer is unavailable so the caller can report "not sent".
     */
    async sendMail(to: string, mail: { subject: string; text: string; html?: string }): Promise<void> {
        const smtp = this.smtp();
        if (!smtp) throw new Error('SMTP_SERVER / SMTP_USER are not set');
        let nodemailer: any;
        try { nodemailer = await import('nodemailer'); } catch { throw new Error('the "nodemailer" package is not installed on the host'); }
        try {
            const transporter = transportFor(nodemailer, smtp);
            await Promise.race([
                transporter.sendMail({ from: smtp.from, to, subject: mail.subject, text: mail.text, html: mail.html }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('smtp timeout (60 s)')), 60_000)),
            ]);
        } catch (e) {
            try { transportCache?.t?.close?.(); } catch { /* ignore */ }
            transportCache = null;
            throw e;
        }
    }

    private smtp(): SmtpSettings | null {
        if (process.env.SMTP_SERVER && process.env.SMTP_USER) {
            return {
                host: process.env.SMTP_SERVER,
                port: Number(process.env.SMTP_PORT || 587),
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASSWORD || '',
                from: process.env.SMTP_FROM || process.env.SMTP_USER,
            };
        }
        return null;
    }

    private async email(ev: OpsEvent): Promise<void> {
        const to = runtimeOptions().ops?.adminEmail;
        const smtp = this.smtp();
        if (!to || !smtp) return;
        let nodemailer: any;
        try {
            nodemailer = await import('nodemailer');
        } catch {
            Logger.warn('ops.adminEmail is set but the "nodemailer" package is not installed — e-mail alerts disabled', loggerCtx);
            return;
        }
        try {
            const transporter = transportFor(nodemailer, smtp);
            const rows = [
                ev.orderCode ? `<tr><td><b>Order</b></td><td>${escapeHtml(ev.orderCode)}</td></tr>` : '',
                (ev.providerRef || ev.paymentIntentId) ? `<tr><td><b>Reference</b></td><td>${escapeHtml(String(ev.providerRef || ev.paymentIntentId))}</td></tr>` : '',
                ev.amountMinor != null ? `<tr><td><b>Amount</b></td><td>${formatMinor(ev.amountMinor, ev.currency)}</td></tr>` : '',
                ev.channelId != null ? `<tr><td><b>Channel</b></td><td>${escapeHtml(String(ev.channelId))}</td></tr>` : '',
            ].join('');
            await Promise.race([
                transporter.sendMail({
                from: smtp.from, to,
                subject: `[Checkout Guard] ${ev.event}${ev.orderCode ? ` — ${ev.orderCode}` : ''}`,
                html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
                    <p>${escapeHtml(ev.text).replace(/\n/g, '<br>')}</p>
                    ${rows ? `<table cellpadding="4">${rows}</table>` : ''}
                    </div>`,
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('smtp timeout (60 s)')), 60_000)),
            ]);
        } catch (e: any) {
            // Drop a broken pooled connection so the next alert reconnects.
            try { transportCache?.t?.close?.(); } catch { /* ignore */ }
            transportCache = null;
            Logger.warn(`Ops e-mail failed: ${e?.message || e}`, loggerCtx);
        }
    }
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

/** Format minor units for humans: 1234 GBP → "£12.34". Never fabricates a
 *  currency: falls back to the bare number when none is known. */
export function formatMinor(amountMinor: number, currency?: string | null): string {
    const major = amountMinor / 100;
    if (!currency) return major.toFixed(2);
    try {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(major);
    } catch {
        return `${major.toFixed(2)} ${currency}`;
    }
}
