import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { EventBus, Logger, Order, Payment, TransactionalConnection } from '@vendure/core';
import { Subscription } from 'rxjs';
import { BankTransferExpiredEvent, BankTransferReminderEvent } from './bank-transfer.events';
import { readBankTransferPublicDetails, BankTransferPublicDetails } from './bank-details';

const loggerCtx = 'CheckoutGuard:BankTransfer';

/**
 * Bank-transfer reminder and expiry e-mails to the customer (PREMIUM, opt-in
 * with `bankTransfer.emails: true` or the Settings tab).
 *
 * The expiry sweep has always published `BankTransferReminderEvent` and
 * `BankTransferExpiredEvent` for hosts to send their own mail; this sends a
 * plain branded-neutral message itself, through the same SMTP transport the
 * ops alerts and weekly report use. Off by default, so a host that already
 * mails from those events is not doubled up.
 */
export interface BankEmailRuntime {
    enabled(): boolean;
    hasPremiumAccess(): boolean;
    send(to: string, mail: { subject: string; text: string; html: string }): Promise<void>;
    /** Shop name for the greeting line (channel or `publicBaseUrl` host). */
    storeName(): string;
}

let runtime: BankEmailRuntime = {
    enabled: () => false,
    hasPremiumAccess: () => false,
    send: async () => { throw new Error('not configured'); },
    storeName: () => '',
};

export function setBankEmailRuntime(rt: Partial<BankEmailRuntime>): void {
    runtime = { ...runtime, ...rt };
}

function esc(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function formatAmount(minor: number, currency: string): string {
    const cur = (currency || '').toUpperCase();
    try {
        const f = new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur });
        const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
        return f.format(minor / Math.pow(10, digits));
    } catch {
        return `${(minor / 100).toFixed(2)} ${cur}`;
    }
}

function day(iso: string | Date): string {
    const d = iso instanceof Date ? iso : new Date(iso);
    return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : String(iso);
}

/** Compose the reminder or expiry e-mail. Pure. */
export function composeBankEmail(kind: 'reminder' | 'expired', input: {
    orderCode: string; payBy: Date; details: BankTransferPublicDetails | null; storeName?: string; amountMinor?: number; currency?: string;
}): { subject: string; text: string; html: string } {
    const d = input.details;
    const amount = formatAmount(d?.amountMinor ?? input.amountMinor ?? 0, d?.currency ?? input.currency ?? 'GBP');
    const store = (input.storeName || '').trim();
    const sig = store ? `\n\n${store}` : '';
    if (kind === 'expired') {
        const subject = `Your order ${input.orderCode} has been cancelled`;
        const body = `We did not receive your bank transfer of ${amount} for order ${input.orderCode} by ${day(input.payBy)}, so the order has been cancelled. If you have just paid, please reply to this e-mail with the payment details and we will sort it out.`;
        return { subject, text: body + sig, html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px"><p>${esc(body)}</p>${store ? `<p>${esc(store)}</p>` : ''}</div>` };
    }
    const rows: Array<[string, string | undefined]> = [
        ['Account name', d?.accountName], ['Sort code', d?.sortCode], ['Account number', d?.accountNumber],
        ['IBAN', d?.iban], ['BIC', d?.bic], ['Reference', d?.reference || input.orderCode], ['Amount', amount],
    ];
    const shown = rows.filter((r): r is [string, string] => !!r[1]);
    const intro = `We have not received your bank transfer for order ${input.orderCode} yet. Please pay ${amount} by ${day(input.payBy)} so we can process your order; after that date the order is cancelled.`;
    const text = `${intro}\n\n${shown.map(([k, v]) => `${k}: ${v}`).join('\n')}${d?.hostedInstructionsUrl ? `\n\nPayment instructions: ${d.hostedInstructionsUrl}` : ''}${sig}`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
<p>${esc(intro)}</p>
<table cellpadding="4" style="border-collapse:collapse">${shown.map(([k, v]) => `<tr><td style="color:#555">${esc(k)}</td><td><strong>${esc(v)}</strong></td></tr>`).join('')}</table>
${d?.hostedInstructionsUrl ? `<p><a href="${esc(d.hostedInstructionsUrl)}">Payment instructions</a></p>` : ''}
${store ? `<p>${esc(store)}</p>` : ''}
</div>`;
    return { subject: `Reminder: your bank transfer for order ${input.orderCode}`, text, html };
}

@Injectable()
export class BankTransferEmailSubscriber implements OnApplicationBootstrap, OnModuleDestroy {
    private subs: Subscription[] = [];

    constructor(private eventBus: EventBus, private connection: TransactionalConnection) {}

    onApplicationBootstrap(): void {
        this.subs.push(this.eventBus.ofType(BankTransferReminderEvent).subscribe(e => { void this.handle('reminder', e.order, e.payment, e.payBy); }));
        this.subs.push(this.eventBus.ofType(BankTransferExpiredEvent).subscribe(e => { void this.handle('expired', e.order, e.payment, e.payBy); }));
    }

    onModuleDestroy(): void {
        for (const s of this.subs) s.unsubscribe();
        this.subs = [];
    }

    /** Returns true when a message was sent. Never throws. */
    async handle(kind: 'reminder' | 'expired', order: Order, payment: Payment, payBy: Date): Promise<boolean> {
        try {
            if (!runtime.enabled() || !runtime.hasPremiumAccess()) return false;
            let email = order?.customer?.emailAddress;
            if (!email && order?.id) {
                const full = await this.connection.rawConnection.getRepository(Order).findOne({ where: { id: order.id }, relations: ['customer'] });
                email = full?.customer?.emailAddress;
            }
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
            const mail = composeBankEmail(kind, {
                orderCode: order.code, payBy, details: readBankTransferPublicDetails(payment?.metadata),
                storeName: runtime.storeName(), amountMinor: payment?.amount, currency: order.currencyCode,
            });
            await runtime.send(email, mail);
            Logger.info(`Bank transfer ${kind} e-mail sent for order ${order.code}`, loggerCtx);
            return true;
        } catch (e: any) {
            Logger.warn(`Bank transfer ${kind} e-mail for order ${order?.code ?? '?'} not sent: ${e?.message || e}`, loggerCtx);
            return false;
        }
    }
}
