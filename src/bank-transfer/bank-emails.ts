import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { EventBus, Logger, Order, Payment, TransactionalConnection } from '@vendure/core';
import { Subscription } from 'rxjs';
import { BankTransferExpiredEvent, BankTransferReminderEvent } from './bank-transfer.events';
import { readBankTransferPublicDetails, BankTransferPublicDetails } from './bank-details';
import { accentOf, EmailBranding, infoBox, paragraph, renderLayout, renderText, Row, rowsText, safeEmail, safeUrl, button, warningBox } from '../email/layout';

const loggerCtx = 'CheckoutGuard:BankTransfer';

/**
 * Bank-transfer reminder and expiry e-mails to the customer (PREMIUM, opt-in
 * with `bankTransfer.emails: true` or the Settings tab).
 *
 * The expiry sweep has always published `BankTransferReminderEvent` and
 * `BankTransferExpiredEvent` for hosts to send their own mail; this sends a
 * message in the merchant's own look (`email` option) itself, through the same SMTP transport the
 * ops alerts and weekly report use. Off by default, so a host that already
 * mails from those events is not doubled up.
 */
export interface BankEmailRuntime {
    enabled(): boolean;
    hasPremiumAccess(): boolean;
    send(to: string, mail: { subject: string; text: string; html: string }): Promise<void>;
    /** Shop name for the header and sign-off when `email.storeName` is not set (`publicBaseUrl` host). */
    storeName(): string;
    /** The merchant's e-mail look (`email` option / Settings tab). */
    branding(): EmailBranding;
}

let runtime: BankEmailRuntime = {
    enabled: () => false,
    hasPremiumAccess: () => false,
    send: async () => { throw new Error('not configured'); },
    storeName: () => '',
    branding: () => ({}),
};

export function setBankEmailRuntime(rt: Partial<BankEmailRuntime>): void {
    runtime = { ...runtime, ...rt };
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

export interface BankEmailInput {
    orderCode: string;
    payBy: Date;
    details: BankTransferPublicDetails | null;
    /** Fallback store name (the `branding.storeName` wins). */
    storeName?: string;
    amountMinor?: number;
    currency?: string;
    branding?: EmailBranding | null;
}

/**
 * Compose the reminder or expiry e-mail (HTML and plain text). Pure.
 * The reminder carries the order's own bank details and payment reference,
 * exactly as stored on the payment, so the customer can pay from it.
 */
export function composeBankEmail(kind: 'reminder' | 'expired', input: BankEmailInput): { subject: string; text: string; html: string } {
    const d = input.details;
    const branding: EmailBranding = { ...(input.branding || {}) };
    if (!String(branding.storeName || '').trim()) branding.storeName = (input.storeName || '').trim();
    const accent = accentOf(branding);
    const amount = formatAmount(d?.amountMinor ?? input.amountMinor ?? 0, d?.currency ?? input.currency ?? 'GBP');
    const dueBy = day(input.payBy);
    const support = safeEmail(branding.supportEmail);

    if (kind === 'expired') {
        const subject = `Your order ${input.orderCode} has been cancelled`;
        const intro = `We did not receive your bank transfer of ${amount} for order ${input.orderCode} by ${dueBy}, so the order has been cancelled.`;
        const paid = 'If you have just paid, please reply to this e-mail with the payment details and we will sort it out.';
        const rows: Row[] = [
            { label: 'Order', value: input.orderCode, mono: true },
            { label: 'Amount', value: amount },
            { label: 'Was due by', value: dueBy },
        ];
        const help = support ? `You can also write to us at ${support}.` : '';
        const heading = 'Your order has been cancelled';
        const html = renderLayout({
            branding, heading, preheader: intro,
            body: paragraph(intro) + infoBox(rows, { accent }) + paragraph(paid) + (help ? paragraph(help) : ''),
        });
        const text = renderText({ branding, heading, lines: [intro, '', ...rowsText(rows), '', paid, ...(help ? [help] : [])] });
        return { subject, text, html };
    }

    const reference = d?.reference || input.orderCode;
    const bankRows: Row[] = [];
    if (d?.accountName) bankRows.push({ label: 'Account name', value: d.accountName });
    if (d?.sortCode) bankRows.push({ label: 'Sort code', value: d.sortCode, mono: true });
    if (d?.accountNumber) bankRows.push({ label: 'Account number', value: d.accountNumber, mono: true });
    if (d?.iban) bankRows.push({ label: 'IBAN', value: d.iban, mono: true });
    if (d?.bic) bankRows.push({ label: 'BIC', value: d.bic, mono: true });
    const hasAccount = bankRows.length > 0;
    bankRows.push({ label: 'Reference', value: reference, mono: true, accent: true });
    bankRows.push({ label: 'Amount', value: amount });
    bankRows.push({ label: 'Please pay by', value: dueBy });

    const intro = `We have not received your bank transfer for order ${input.orderCode} yet. Please pay ${amount} by ${dueBy} so we can process your order; after that date the order is cancelled.`;
    const boxIntro = 'Please transfer the amount below, quoting the reference exactly. It is unique to your order, so your payment is matched automatically.';
    const noAccount = hasAccount ? '' : 'Please use the bank details from your order confirmation.';
    const instructions = (d?.instructions || '').trim();
    const note = [noAccount, instructions].filter(Boolean).join(' ');
    const hosted = safeUrl(d?.hostedInstructionsUrl);
    const already = 'If you have already sent the transfer, thank you: there is nothing more to do. Transfers can take a little while to reach us.';
    const help = support ? `Questions? Write to us at ${support}.` : '';
    const heading = 'Your bank transfer is still due';
    const html = renderLayout({
        branding, heading, preheader: `Please pay ${amount} by ${dueBy}, quoting ${reference}.`,
        body: paragraph(intro)
            + warningBox({ title: 'Complete your bank transfer', intro: boxIntro, rows: bankRows, note, accent })
            + (hosted ? button(hosted, 'View payment instructions', accent, 'primary') : '')
            + paragraph(already) + (help ? paragraph(help) : ''),
    });
    const text = renderText({
        branding, heading,
        lines: [intro, '', 'Complete your bank transfer', boxIntro, '', ...rowsText(bankRows), ...(note ? ['', note] : []),
            ...(hosted ? ['', `Payment instructions: ${hosted}`] : []), '', already, ...(help ? [help] : [])],
    });
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
                storeName: runtime.storeName(), branding: runtime.branding(), amountMinor: payment?.amount, currency: order.currencyCode,
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
