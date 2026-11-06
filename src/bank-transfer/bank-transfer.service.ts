import { adapterFor } from '@huloglobal/vendure-licence-sdk';
import { withDbLock } from '../db-lock';
import { Injectable, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import {
    Channel,
    EventBus,
    ID,
    Logger,
    Order,
    OrderService,
    OrderStateTransitionEvent,
    Payment,
    RequestContext,
    RequestContextService,
    TransactionalConnection,
    isGraphQlErrorResult,
} from '@vendure/core';

import { formatMinor, fromStripeMinorUnits, isPaymentIntentId } from '../stripe-hold/hold-utils';
import { retrievePaymentIntent } from '../stripe-hold/stripe-api';
import type { WebhookOutcome } from '../stripe-hold/stripe-hold.service';
import { getStripeKeyForChannelId } from '../stripe-hold/stripe-key';
import { BANK_TRANSFER_HANDLER_CODE, parsePayBy, readBankTransferPublicDetails } from './bank-details';
import { BankTransferOpsEvent, getBankTransferRuntime, notifyBankTransferOps } from './bank-transfer-runtime';
import { BankTransferExpiredEvent, BankTransferReminderEvent } from './bank-transfer.events';
import { classifyBankTransfer, daysUntil } from './expiry-policy';
import {
    STRIPE_BANK_TRANSFER_TIMEOUT_MS, StripeBankTransferIntentLike, describeStripeFailure, isMissingAtStripe, noteStripeTransferSucceeded,
    parseBankTransferStripeMetadata, retrieveCustomerCashBalance, settledThroughStripe, stripeChannelIdOf, stripeCustomerIdOf,
    stripePaymentIntentIdOf, stripeTransferFunding,
} from './stripe-bank-transfer';

const loggerCtx = 'CheckoutGuard';

/** The sweep asks Stripe about one open transfer at most this often. */
const STRIPE_CHECK_INTERVAL_MS = 10 * 60_000;
/** Cap per run, so one slow pass stays well inside the ten-minute schedule. */
const STRIPE_CHECKS_PER_RUN = 50;
/** No new check starts after this much of a run: the lock it shares with the expiry sweep is free again well before the next run. */
const STRIPE_SYNC_BUDGET_MS = 3 * 60_000;
/** Per Stripe call in the ten-minute sweep. */
const STRIPE_SYNC_CALL_TIMEOUT_MS = 10_000;
/** A succeeded intent no payment carries yet is retried (503) while younger than this: its checkout may still be committing. */
const UNMATCHED_GRACE_MS = 10 * 60_000;
/** An intent cancelled at Stripe more recently than this may be our own cancel whose transaction has not committed yet. */
const CANCELLED_AT_STRIPE_GRACE_MS = 2 * 60_000;
/** A transfer Stripe cannot be asked about is alerted once it is this far past its pay-by date. */
const CHECK_FAILED_ALERT_AFTER_MS = 24 * 3_600_000;
const CHANNEL_CACHE_MS = 60_000;
/** Order states in which the order is already paid: a Stripe receipt for it is a second payment. */
const PAID_ORDER_STATES = new Set(['PaymentSettled', 'PartiallyShipped', 'Shipped', 'PartiallyDelivered', 'Delivered']);
/** Cash balance transactions that can leave money in a customer's balance. */
const CASH_BALANCE_TYPES = new Set(['funded', 'unapplied_from_payment', 'applied_to_payment']);

export type BankTransferListStatus = 'awaiting' | 'expired' | 'settled' | 'cancelled' | 'all';

/** One row of the admin listing. */
export interface BankTransferRow {
    paymentId: ID;
    orderId: ID;
    orderCode: string;
    channelId: ID;
    channelCode: string | null;
    customerEmail: string | null;
    amountMinor: number;
    currency: string;
    paymentState: string;
    orderState: string;
    createdAt: string;
    /** ISO pay-by moment (from the payment's public metadata, else createdAt + expiryDays). */
    payBy: string;
    /** Whole days until payBy (negative when past). */
    daysLeft: number;
    reminderSentAt: string | null;
    expiredAt: string | null;
    settledAt: string | null;
    cancelledAt: string | null;
    accountName: string | null;
    /** `'stripe'` for a Stripe bank transfer (settles by itself), null for the payment method's own details. */
    provider: 'stripe' | null;
    /** The Stripe PaymentIntent behind a Stripe bank transfer. */
    paymentIntentId: string | null;
}

/** One pass of the Stripe check (`syncStripe`). */
export interface StripeBankTransferSyncResult {
    /** Transfers Stripe was asked about. */
    checked: number;
    /** Of those, settled because Stripe had received the money. */
    settled: number;
    /** Still waiting for (some of) the money. */
    awaiting: number;
    skipped: 'disabled' | 'locked' | null;
}

export interface BankTransferSweepResult {
    scanned: number;
    expired: number;
    reminded: number;
    /** Orders whose bank payment was already cancelled but the order was not (a
     *  failed cancelOrder on an earlier pass) and were cancelled on this pass. */
    repaired: number;
    skipped: 'locked' | null;
}

export interface BankTransferActionResult {
    ok: boolean;
    error?: string;
    paymentState?: string;
    orderState?: string;
}

interface CandidateRow {
    paymentId: ID;
    orderId: ID;
    orderCode: string;
    channelId: ID;
    paymentCreatedAt: string | Date;
    amount: number;
    metadata: unknown;
    reminderSentAt: string | Date | null;
}

/**
 * @docsCategory Services
 * @category Services
 */
@Injectable()
export class BankTransferService implements OnModuleInit, OnApplicationBootstrap {
    private lockedLogged = false;

    constructor(
        private connection: TransactionalConnection,
        private orderService: OrderService,
        private requestContextService: RequestContextService,
        private eventBus: EventBus,
    ) {}

    private get db() {
        return adapterFor(this.connection.rawConnection);
    }

    async onModuleInit() {
        try {
            await this.ensureSchema();
        } catch (e: any) {
            Logger.error(`bank-transfer schema init failed: ${e.message}`, loggerCtx);
        }
    }

    // ── Schema ──────────────────────────────────────────────────────────
    /**
     * Tracking rows keyed by payment id. The payment/order tables stay the
     * source of truth for state; this table only remembers what the sweep
     * has already done (reminder sent, expired) and when an admin acted.
     * Created with plain DDL through the dialect adapter — the host runs with
     * plugin migrations off, so no TypeORM entity.
     */
    async ensureSchema(): Promise<void> {
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS checkout_guard_bank_transfer (
                paymentId BIGINT PRIMARY KEY,
                orderId BIGINT NOT NULL,
                orderCode VARCHAR(64) NOT NULL,
                channelId INT NOT NULL,
                amountMinor BIGINT NOT NULL DEFAULT 0,
                currency VARCHAR(8) NULL,
                payBy DATETIME NULL,
                reminderSentAt DATETIME NULL,
                expiredAt DATETIME NULL,
                settledAt DATETIME NULL,
                cancelledAt DATETIME NULL,
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_cg_bt_order (orderId),
                INDEX idx_cg_bt_channel (channelId)
            )`);
    }

    // ── Method codes ────────────────────────────────────────────────────
    /**
     * `payment.method` stores the PaymentMethod *code*, which a host may name
     * differently from the handler code (ELITE's row is `bank-transfer`, but a
     * second channel could be `bacs`). Resolve every enabled-or-not method
     * whose handler is ours.
     */
    private codesCache: { at: number; codes: string[] } | null = null;

    async bankTransferMethodCodes(): Promise<string[]> {
        if (this.codesCache && Date.now() - this.codesCache.at < 30_000) return this.codesCache.codes;
        const codes = await this.loadBankTransferMethodCodes();
        this.codesCache = { at: Date.now(), codes };
        return codes;
    }

    private async loadBankTransferMethodCodes(): Promise<string[]> {
        const rows: Array<{ code: string; handler: unknown }> = await this.db.query(
            `SELECT code, handler FROM payment_method`,
        );
        const codes: string[] = [];
        for (const row of rows ?? []) {
            let handler: any = row.handler;
            if (typeof handler === 'string') {
                try { handler = JSON.parse(handler); } catch { handler = null; }
            }
            if (handler && handler.code === BANK_TRANSFER_HANDLER_CODE && row.code) codes.push(String(row.code));
        }
        // The handler code itself is a sensible fallback so a fresh install
        // still sweeps if the method row is created with the same code.
        if (!codes.includes(BANK_TRANSFER_HANDLER_CODE)) codes.push(BANK_TRANSFER_HANDLER_CODE);
        return codes;
    }

    private placeholders(n: number): string {
        return Array.from({ length: n }, () => '?').join(', ');
    }

    // ── Listing (admin) ─────────────────────────────────────────────────
    async list(status: BankTransferListStatus = 'awaiting', days = 90, limit = 200, ctx?: RequestContext): Promise<BankTransferRow[]> {
        const codes = await this.bankTransferMethodCodes();
        const runtime = getBankTransferRuntime();
        const where: string[] = [`p.method IN (${this.placeholders(codes.length)})`];
        const params: any[] = [...codes];
        // A non-default channel admin only sees that channel's orders.
        const scope = scopedChannelId(ctx);
        if (scope) {
            where.push('EXISTS (SELECT 1 FROM order_channels_channel x WHERE x.\`orderId\` = o.id AND x.\`channelId\` = ?)');
            params.push(scope);
        }
        switch (status) {
            case 'awaiting':
                where.push(`p.state = 'Authorized'`);
                break;
            case 'settled':
                where.push(`p.state = 'Settled'`);
                break;
            case 'expired':
                where.push(`p.state = 'Cancelled'`, `t.expiredAt IS NOT NULL`);
                break;
            case 'cancelled':
                where.push(`p.state = 'Cancelled'`);
                break;
            case 'all':
            default:
                break;
        }
        const safeDays = Math.max(1, Math.min(3650, Math.floor(Number(days) || 90)));
        where.push(`p.\`createdAt\` >= DATE_SUB(NOW(), INTERVAL ? DAY)`);
        params.push(safeDays);
        const safeLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));

        const rows: any[] = await this.db.query(
            `SELECT p.id AS paymentId, p.state AS paymentState, p.amount AS amountMinor, p.\`createdAt\` AS createdAt,
                    p.\`updatedAt\` AS paymentUpdatedAt, p.metadata AS metadata,
                    o.id AS orderId, o.code AS orderCode, o.state AS orderState, o.\`currencyCode\` AS currency,
                    c.\`emailAddress\` AS customerEmail,
                    ch.id AS channelId, ch.code AS channelCode,
                    t.reminderSentAt AS reminderSentAt, t.expiredAt AS expiredAt, t.settledAt AS settledAt,
                    t.cancelledAt AS cancelledAt, t.payBy AS trackedPayBy
             FROM payment p
             JOIN \`order\` o ON o.id = p.\`orderId\`
             LEFT JOIN customer c ON c.id = o.\`customerId\`
             LEFT JOIN order_channels_channel occ ON occ.\`orderId\` = o.id
             LEFT JOIN channel ch ON ch.id = occ.\`channelId\`
             LEFT JOIN checkout_guard_bank_transfer t ON t.paymentId = p.id
             WHERE ${where.join(' AND ')}
             ORDER BY p.\`createdAt\` DESC
             LIMIT ${safeLimit * 4}`,
            params,
        );
        // An order belongs to its own channel AND the default channel, so the
        // join yields one row per channel. Keep the non-default one.
        const byPayment = new Map<string, any>();
        for (const r of rows ?? []) {
            const key = String(r.paymentId);
            const existing = byPayment.get(key);
            if (!existing || (String(existing.channelId) === '1' && String(r.channelId) !== '1')) byPayment.set(key, r);
        }
        const now = new Date();
        const out: BankTransferRow[] = [];
        for (const r of byPayment.values()) {
            const details = readBankTransferPublicDetails(r.metadata);
            const createdAt = new Date(r.createdAt);
            const payByDate = parsePayBy(details)
                ?? (r.trackedPayBy ? new Date(r.trackedPayBy) : null)
                ?? new Date(createdAt.getTime() + runtime.expiryDays * 86_400_000);
            out.push({
                paymentId: r.paymentId,
                orderId: r.orderId,
                orderCode: r.orderCode,
                channelId: r.channelId,
                channelCode: r.channelCode ?? null,
                customerEmail: r.customerEmail ?? null,
                amountMinor: Number(r.amountMinor) || 0,
                currency: details?.currency || r.currency,
                paymentState: r.paymentState,
                orderState: r.orderState,
                createdAt: createdAt.toISOString(),
                payBy: payByDate.toISOString(),
                daysLeft: daysUntil(payByDate, now),
                reminderSentAt: toIso(r.reminderSentAt),
                expiredAt: toIso(r.expiredAt),
                settledAt: toIso(r.settledAt) ?? (r.paymentState === 'Settled' ? toIso(r.paymentUpdatedAt) : null),
                cancelledAt: toIso(r.cancelledAt) ?? (r.paymentState === 'Cancelled' ? toIso(r.paymentUpdatedAt) : null),
                accountName: details?.accountName ?? null,
                provider: details?.provider === 'stripe' ? 'stripe' : null,
                paymentIntentId: stripePaymentIntentIdOf(r.metadata),
            });
            if (out.length >= safeLimit) break;
        }
        return out;
    }

    /** KPI helper for the dashboard summary: bank transfers still awaiting funds. */
    async countAwaiting(): Promise<number> {
        const codes = await this.bankTransferMethodCodes();
        const [row] = await this.db.query(
            `SELECT COUNT(*) AS n FROM payment p WHERE p.state = 'Authorized' AND p.method IN (${this.placeholders(codes.length)})`,
            codes,
        );
        return Number(row?.n || 0);
    }

    // ── Admin actions ───────────────────────────────────────────────────
    /** Funds arrived: settle the payment, which moves the order to PaymentSettled. */
    async markReceived(paymentId: ID, reqCtx?: RequestContext): Promise<BankTransferActionResult> {
        const payment = await this.loadBankTransferPayment(paymentId);
        if (!payment || !visibleIn(payment, reqCtx)) return { ok: false, error: 'not_a_bank_transfer_payment' };
        if (payment.state !== 'Authorized') {
            return { ok: false, error: `payment_not_authorized:${payment.state}`, paymentState: payment.state, orderState: payment.order.state };
        }
        const ctx = await this.contextForOrder(payment.order);
        // Settle under a row lock with the state re-read inside it, so the
        // expiry sweep (worker) and this admin action (server) cannot both act.
        const result = await this.settleUnderLock(ctx, payment.id);
        if ('stale' in result) {
            return { ok: false, error: `payment_not_authorized:${result.stale}`, paymentState: String(result.stale), orderState: payment.order.state };
        }
        if (isGraphQlErrorResult(result)) {
            return { ok: false, error: result.message, paymentState: payment.state, orderState: payment.order.state };
        }
        await this.trackSettled(payment, ctx.channelId);
        const order = await this.orderService.findOne(ctx, payment.order.id);
        Logger.info(`Bank transfer received for order ${payment.order.code} (payment ${payment.id})`, loggerCtx);
        return { ok: true, paymentState: result.state, orderState: order?.state ?? payment.order.state };
    }

    /** Admin cancel: cancel the payment and the order (no expiry event). */
    async cancelByAdmin(paymentId: ID, reason?: string, reqCtx?: RequestContext): Promise<BankTransferActionResult> {
        const payment = await this.loadBankTransferPayment(paymentId);
        if (!payment || !visibleIn(payment, reqCtx)) return { ok: false, error: 'not_a_bank_transfer_payment' };
        if (payment.state !== 'Authorized') {
            return { ok: false, error: `payment_not_authorized:${payment.state}`, paymentState: payment.state, orderState: payment.order.state };
        }
        const ctx = await this.contextForOrder(payment.order);
        const outcome = await this.cancelPaymentAndOrder(ctx, payment, reason || 'Bank transfer cancelled by administrator');
        if (!outcome.ok) return outcome;
        await this.ensureTracked(payment, ctx.channelId);
        await this.db.query(`UPDATE checkout_guard_bank_transfer SET cancelledAt = NOW() WHERE paymentId = ?`, [payment.id]);
        Logger.info(`Bank transfer cancelled by admin for order ${payment.order.code} (payment ${payment.id})`, loggerCtx);
        return outcome;
    }

    // ── Sweep (cron, premium) ───────────────────────────────────────────
    /**
     * Expire unpaid transfers past their pay-by date and publish one reminder
     * per payment after `reminderAfterDays`. Premium only: when locked the
     * sweep logs once and does nothing — the handler and checker keep working
     * on the free tier, orders just wait for a human.
     */
    async sweep(now: Date = new Date()): Promise<BankTransferSweepResult> {
        const runtime = getBankTransferRuntime();
        if (!runtime.hasPremiumAccess()) {
            if (!this.lockedLogged) {
                this.lockedLogged = true;
                Logger.warn(
                    'Bank-transfer auto-expiry and reminders are a premium feature — unpaid transfers will not be expired automatically. Activate a licence to enable them.',
                    loggerCtx,
                );
            }
            return { scanned: 0, expired: 0, reminded: 0, repaired: 0, skipped: 'locked' };
        }
        this.lockedLogged = false;

        const locked = await withDbLock(this.connection.rawConnection, 'bank-sweep', () => this.sweepLocked(now, runtime));
        if (!locked.acquired) {
            Logger.warn('Bank-transfer sweep skipped — another process holds the sweep lock', loggerCtx);
            return { scanned: 0, expired: 0, reminded: 0, repaired: 0, skipped: 'locked' };
        }
        return locked.result!;
    }

    private async sweepLocked(now: Date, runtime: ReturnType<typeof getBankTransferRuntime>): Promise<BankTransferSweepResult> {
        const candidates = await this.findAwaitingCandidates();
        const result: BankTransferSweepResult = { scanned: candidates.length, expired: 0, reminded: 0, repaired: 0, skipped: null };
        for (const c of candidates) {
            try {
                const details = readBankTransferPublicDetails(c.metadata);
                const decision = classifyBankTransfer({
                    now,
                    createdAt: new Date(c.paymentCreatedAt),
                    payBy: parsePayBy(details),
                    reminderSentAt: c.reminderSentAt ? new Date(c.reminderSentAt) : null,
                    expiryDays: runtime.expiryDays,
                    reminderAfterDays: runtime.reminderAfterDays,
                });
                if (!decision.expire && !decision.remind) continue;

                const payment = await this.loadBankTransferPayment(c.paymentId);
                if (!payment || payment.state !== 'Authorized' || payment.order.state !== 'PaymentAuthorized') continue;
                const ctx = await this.contextForOrder(payment.order);
                await this.ensureTracked(payment, ctx.channelId, decision.expiresAt);

                if (decision.expire) {
                    // A Stripe bank transfer may have been paid since Stripe was last
                    // asked: check first, and never expire one Stripe could not confirm.
                    // (A part payment is alerted by the handler's cancel.)
                    const stripe = await this.stripeBeforeExpiry(payment, decision.expiresAt, now);
                    if (stripe === 'settled' || stripe === 'unknown') continue;
                    // Record the expiry before cancelling so a half-finished
                    // cancellation is recognisable (and repairable) as ours.
                    await this.db.query(
                        `UPDATE checkout_guard_bank_transfer SET expiredAt = NOW() WHERE paymentId = ? AND expiredAt IS NULL`, [payment.id],
                    );
                    const outcome = await this.cancelPaymentAndOrder(
                        ctx, payment, `Bank transfer not received by ${decision.expiresAt.toISOString().slice(0, 10)}`,
                    );
                    if (!outcome.ok) {
                        Logger.warn(`Could not expire bank transfer for order ${payment.order.code}: ${outcome.error}`, loggerCtx);
                        continue;
                    }
                    await this.db.query(
                        `UPDATE checkout_guard_bank_transfer SET expiredAt = NOW(), cancelledAt = NOW() WHERE paymentId = ?`,
                        [payment.id],
                    );
                    const order = (await this.orderService.findOne(ctx, payment.order.id)) ?? payment.order;
                    await this.eventBus.publish(new BankTransferExpiredEvent(ctx, order, payment, decision.expiresAt));
                    result.expired++;
                    Logger.info(`Expired unpaid bank transfer for order ${payment.order.code} (payment ${payment.id})`, loggerCtx);
                } else if (decision.remind) {
                    await this.db.query(
                        `UPDATE checkout_guard_bank_transfer SET reminderSentAt = NOW() WHERE paymentId = ? AND reminderSentAt IS NULL`,
                        [payment.id],
                    );
                    await this.eventBus.publish(new BankTransferReminderEvent(ctx, payment.order, payment, decision.expiresAt));
                    result.reminded++;
                    Logger.info(`Bank transfer reminder due for order ${payment.order.code} (payment ${payment.id})`, loggerCtx);
                }
            } catch (e: any) {
                Logger.error(`Bank transfer sweep failed for payment ${c.paymentId}: ${e.message}`, loggerCtx);
            }
        }
        result.repaired = await this.repairStranded();
        return result;
    }

    /**
     * A previous pass cancelled the payment but `cancelOrder` failed (the two
     * steps are separate Vendure operations): the order sits in
     * PaymentAuthorized with only Cancelled bank payments and nothing else
     * would ever touch it. Finish the cancellation.
     */
    private async repairStranded(): Promise<number> {
        const codes = await this.bankTransferMethodCodes();
        if (!codes.length) return 0;
        const ph = this.placeholders(codes.length);
        const rows: Array<{ orderId: ID; orderCode: string }> = await this.db.query(
            `SELECT o.id AS orderId, o.code AS orderCode
             FROM \`order\` o
             WHERE o.state = 'PaymentAuthorized'
               AND EXISTS (SELECT 1 FROM payment p WHERE p.\`orderId\` = o.id AND p.method IN (${ph}) AND p.state = 'Cancelled')
               AND NOT EXISTS (SELECT 1 FROM payment p2 WHERE p2.\`orderId\` = o.id AND p2.state IN ('Authorized', 'Settled'))
               AND EXISTS (SELECT 1 FROM checkout_guard_bank_transfer t WHERE t.orderId = o.id AND t.expiredAt IS NOT NULL)
             LIMIT 100`,
            codes,
        ).catch(() => []);
        let repaired = 0;
        for (const r of rows ?? []) {
            try {
                const order = await this.connection.rawConnection.getRepository(Order).findOne({ where: { id: r.orderId as any }, relations: ['channels'] });
                if (!order) continue;
                const ctx = await this.contextForOrder(order);
                const res = await this.orderService.cancelOrder(ctx, { orderId: order.id, reason: 'Bank transfer not received (order left open by an earlier failed cancellation)' });
                if (isGraphQlErrorResult(res)) {
                    Logger.warn(`Could not finish cancelling stranded order ${r.orderCode}: ${res.message}`, loggerCtx);
                    continue;
                }
                await this.db.query(`UPDATE checkout_guard_bank_transfer SET cancelledAt = COALESCE(cancelledAt, NOW()) WHERE orderId = ?`, [order.id]);
                repaired++;
                Logger.info(`Finished cancelling stranded bank-transfer order ${r.orderCode}`, loggerCtx);
            } catch (e: any) {
                Logger.error(`Stranded-order repair failed for ${r.orderCode}: ${e.message}`, loggerCtx);
            }
        }
        return repaired;
    }

    /**
     * Orders in PaymentAuthorized whose payments are bank-transfer Authorized
     * and nothing else live (no other Authorized/Settled payment from another
     * method — a split-tender order is never expired by this sweep).
     */
    private async findAwaitingCandidates(): Promise<CandidateRow[]> {
        const codes = await this.bankTransferMethodCodes();
        const ph = this.placeholders(codes.length);
        const rows: any[] = await this.db.query(
            `SELECT p.id AS paymentId, p.\`createdAt\` AS paymentCreatedAt, p.amount AS amount, p.metadata AS metadata,
                    o.id AS orderId, o.code AS orderCode,
                    MAX(occ.\`channelId\`) AS channelId,
                    t.reminderSentAt AS reminderSentAt
             FROM payment p
             JOIN \`order\` o ON o.id = p.\`orderId\`
             JOIN order_channels_channel occ ON occ.\`orderId\` = o.id
             LEFT JOIN checkout_guard_bank_transfer t ON t.paymentId = p.id
             WHERE o.state = 'PaymentAuthorized'
               AND p.state = 'Authorized'
               AND p.method IN (${ph})
               AND NOT EXISTS (
                   SELECT 1 FROM payment p2
                   WHERE p2.\`orderId\` = o.id AND p2.id <> p.id
                     AND p2.state IN ('Authorized', 'Settled')
                     AND p2.method NOT IN (${ph})
               )
             GROUP BY p.id, p.\`createdAt\`, p.amount, p.metadata, o.id, o.code, t.reminderSentAt
             ORDER BY p.\`createdAt\` ASC
             LIMIT 500`,
            [...codes, ...codes],
        );
        return rows ?? [];
    }

    // ── Stripe bank transfers (bankTransfer.stripe) ─────────────────────
    /** When the sweep last asked Stripe about each open transfer, and the amount it saw outstanding (per process). */
    private stripeChecks = new Map<string, { at: number; remaining?: number | null }>();
    /** Alerts already raised by this process, so a transfer that needs a human alerts once, not every ten minutes. */
    private stripeAlerted = new Set<string>();
    /** Channels by id for the webhook's secret selection (looked up before the signature is checked). */
    private channelCache = new Map<string, { at: number; channel: Channel | undefined }>();

    /** True while `bankTransfer.stripe` is enabled. */
    stripeEnabled(): boolean {
        return !!getBankTransferRuntime().stripe;
    }

    /** The channel a bank-transfer PaymentIntent was created on (picks the webhook secret). Only plain ids are looked up; cached for a minute. */
    async channelForId(id: ID): Promise<Channel | undefined> {
        const key = String(id ?? '').trim();
        if (!/^\d{1,10}$/.test(key)) return undefined;
        const hit = this.channelCache.get(key);
        if (hit && Date.now() - hit.at < CHANNEL_CACHE_MS) return hit.channel;
        let channel: Channel | undefined;
        try {
            channel = (await this.connection.rawConnection.getRepository(Channel).findOne({ where: { id: key as any } })) ?? undefined;
        } catch {
            return undefined;
        }
        if (this.channelCache.size > 200) this.channelCache.clear();
        this.channelCache.set(key, { at: Date.now(), channel });
        return channel;
    }

    /**
     * Vendure's own "Cancel order" (and any other cancellation that does not go
     * through Checkout Guard) moves the order to Cancelled but leaves its
     * payments alone. With Stripe bank transfers on, an Authorized Stripe
     * transfer of a cancelled order is cancelled too, which cancels its
     * PaymentIntent, so later transfers cannot complete it.
     */
    onApplicationBootstrap() {
        this.eventBus?.ofType?.(OrderStateTransitionEvent)?.subscribe(event => {
            if (event.toState !== 'Cancelled' || !this.stripeEnabled()) return;
            this.releaseCancelledOrder(event.order).catch((e: any) =>
                Logger.warn(`Could not cancel the Stripe bank transfer of cancelled order ${event.order?.code}: ${e?.message || e}`, loggerCtx));
        });
    }

    /** Cancel the open Stripe-backed bank-transfer payments of a cancelled order. Returns how many were cancelled. */
    async releaseCancelledOrder(order: { id: ID; code?: string }): Promise<number> {
        const codes = await this.bankTransferMethodCodes();
        const rows: Array<{ paymentId: ID; metadata: unknown }> = await this.db.query(
            `SELECT p.id AS paymentId, p.metadata AS metadata FROM payment p
             WHERE p.\`orderId\` = ? AND p.state = 'Authorized' AND p.method IN (${this.placeholders(codes.length)})`,
            [order.id, ...codes],
        );
        let cancelled = 0;
        for (const r of rows ?? []) {
            if (!stripePaymentIntentIdOf(r.metadata)) continue;
            const payment = await this.loadBankTransferPayment(r.paymentId);
            if (!payment || payment.state !== 'Authorized' || payment.order.state !== 'Cancelled') continue;
            const ctx = await this.contextForOrder(payment.order);
            const result = await this.connection.withTransaction(ctx, async tctx => {
                const live = await this.lockPayment(tctx, payment.id);
                if (!live || live.state !== 'Authorized') return { stale: live?.state ?? 'missing' };
                return this.orderService.cancelPayment(tctx, payment.id);
            });
            if ('stale' in result) continue;
            if (isGraphQlErrorResult(result)) {
                const why = String((result as any).paymentErrorMessage || result.message);
                const paymentIntentId = stripePaymentIntentIdOf(payment.metadata) ?? undefined;
                Logger.warn(`Order ${payment.order.code} was cancelled, but its Stripe bank transfer could not be: ${why}`, loggerCtx);
                this.alertOnce(`${paymentIntentId}:cancelled_order`, {
                    event: 'bank.stripe_unsettled',
                    text: `Checkout Guard: order ${payment.order.code} was cancelled, but its Stripe bank transfer could not be (${why}). `
                        + 'If the customer has paid, refund them from the Stripe dashboard or reinstate the order.',
                    orderCode: payment.order.code, paymentIntentId, amountMinor: payment.amount, currency: payment.order.currencyCode, provider: 'stripe',
                });
                continue;
            }
            await this.ensureTracked(payment, ctx.channelId);
            await this.db.query(`UPDATE checkout_guard_bank_transfer SET cancelledAt = COALESCE(cancelledAt, NOW()) WHERE paymentId = ?`, [payment.id]);
            cancelled++;
            Logger.info(`Order ${payment.order.code} was cancelled: its Stripe bank transfer (payment ${payment.id}) is cancelled too`, loggerCtx);
        }
        return cancelled;
    }

    /**
     * A signed Stripe event for a PaymentIntent created by the Stripe bank
     * transfer mode (`cg_bank_transfer` metadata). `payment_intent.succeeded`
     * settles the order's Authorized bank-transfer payment for that intent, so
     * the order moves to PaymentSettled; partial funding is logged and the
     * amount still due is updated; anything else is acknowledged. 200, except
     * 503 for a just-created intent that no payment carries yet (the checkout
     * is still committing; Stripe retries) and 500 when the database throws.
     */
    async handleStripeEvent(event: any): Promise<WebhookOutcome> {
        const type = String(event?.type || '');
        const pi: StripeBankTransferIntentLike | undefined = event?.data?.object;
        const meta = parseBankTransferStripeMetadata(pi?.metadata);
        if (!pi || !isPaymentIntentId(pi.id) || !meta) return { status: 200, message: 'Not a Checkout Guard bank transfer, ignored' };
        switch (type) {
            case 'payment_intent.succeeded':
                return this.onStripeTransferSucceeded(pi, meta.orderCode);
            case 'payment_intent.partially_funded': {
                this.logPartFunding(meta.orderCode, pi);
                const { remaining } = stripeTransferFunding(pi);
                if (remaining !== null) {
                    const { payments } = await this.findStripeBackedPayments(meta.orderCode, pi.id);
                    for (const p of payments) await this.refreshAmountDue(p, remaining);
                }
                return { status: 200, message: `Bank transfer ${pi.id} is partly funded; the payment stays open` };
            }
            case 'payment_intent.canceled':
                Logger.info(`Stripe PaymentIntent ${pi.id} for order ${meta.orderCode} is cancelled at Stripe`, loggerCtx);
                return { status: 200, message: `Bank transfer ${pi.id} cancelled at Stripe` };
            default:
                return { status: 200, message: `Event ${type} ignored` };
        }
    }

    private async onStripeTransferSucceeded(pi: StripeBankTransferIntentLike, orderCode: string): Promise<WebhookOutcome> {
        if (pi.status && pi.status !== 'succeeded') return { status: 200, message: `PaymentIntent ${pi.id} is ${pi.status}, nothing to settle` };
        const { orderKnown, payments } = await this.findStripeBackedPayments(orderCode, pi.id);
        if (!payments.length) {
            if (!orderKnown) {
                Logger.verbose(`Stripe bank transfer ${pi.id} names order ${orderCode}, which is not in this database; ignored`, loggerCtx);
                return { status: 200, message: 'Order not found, ignored' };
            }
            const createdMs = Number(pi.created) * 1000;
            if (createdMs > 0 && Date.now() - createdMs < UNMATCHED_GRACE_MS) {
                // Paid at once from a cash balance: the checkout that created it may not have committed yet.
                return { status: 503, message: `No payment carries ${pi.id} yet; retry` };
            }
            const cur = String(pi.currency || '').toUpperCase();
            const msg = `Stripe has received the bank transfer ${pi.id} for order ${orderCode}, but no bank-transfer payment on the order carries it`;
            Logger.warn(msg, loggerCtx);
            this.alertOnce(`${pi.id}:unmatched`, {
                event: 'bank.stripe_unsettled',
                text: `Checkout Guard: ${msg}. Check the order; refund the customer from the Stripe dashboard if the order is not going ahead.`,
                orderCode, paymentIntentId: pi.id, currency: cur || undefined, provider: 'stripe',
                amountMinor: Number.isFinite(Number(pi.amount)) && cur ? fromStripeMinorUnits(Number(pi.amount), cur) : undefined,
            });
            return { status: 200, message: 'No bank-transfer payment for this PaymentIntent' };
        }
        const r = await this.settleFromStripe(payments, pi, 'webhook');
        return { status: 200, message: r.message };
    }

    /**
     * `customer_cash_balance_transaction.created`: money reached, or went back
     * to, the cash balance of a Stripe customer this plugin created. While the
     * customer has an open Stripe bank transfer, Stripe applies new money to it
     * and the PaymentIntent events take over. Otherwise whatever is still in the
     * balance paid no order (a transfer after the order was cancelled or
     * expired, an overpayment), and it is alerted once per amount for a refund.
     * Money a Checkout Guard cancel returned was alerted by that cancel.
     */
    async handleCashBalanceEvent(event: any): Promise<WebhookOutcome> {
        const txn = event?.data?.object;
        const type = String(txn?.type || '');
        const customerId = idOf(txn?.customer);
        if (txn?.object !== 'customer_cash_balance_transaction' || !customerId || !/^cus_[A-Za-z0-9]+$/.test(customerId)) {
            return { status: 200, message: 'Not a cash balance transaction, ignored' };
        }
        if (!CASH_BALANCE_TYPES.has(type)) return { status: 200, message: `Cash balance ${type} ignored` };
        if (type === 'applied_to_payment' && !(Number(txn.ending_balance) > 0)) return { status: 200, message: 'Cash balance fully applied' };
        const intentId = type === 'applied_to_payment' ? idOf(txn.applied_to_payment?.payment_intent)
            : type === 'unapplied_from_payment' ? idOf(txn.unapplied_from_payment?.payment_intent) : null;
        const payments = await this.paymentsOfStripeCustomer(customerId);
        if (!payments.length) return { status: 200, message: 'Not a Checkout Guard customer, ignored' };
        if (type === 'unapplied_from_payment' && intentId && payments.some(p => p.paymentIntentId === intentId)) {
            return { status: 200, message: 'Returned from a Checkout Guard bank transfer; alerted when it was cancelled' };
        }
        if (payments.some(p => p.state === 'Authorized' && p.paymentIntentId !== intentId)) {
            return { status: 200, message: 'The customer has an open bank transfer; Stripe applies the money to it' };
        }
        const latest = payments[0];
        const apiKey = await getStripeKeyForChannelId(this.connection, latest.channelId, { preferOwnMethod: true });
        if (!apiKey) return { status: 200, message: 'No Stripe key for the customer\'s channel' };
        const currency = String(txn.currency || '').toLowerCase();
        let available: number;
        try {
            available = (await retrieveCustomerCashBalance(apiKey, customerId))[currency] ?? 0;
        } catch (e) {
            Logger.warn(`Could not read the Stripe cash balance of ${customerId}: ${describeStripeFailure(e)}`, loggerCtx);
            return { status: 200, message: 'Cash balance not readable; logged' };
        }
        if (!(available > 0)) return { status: 200, message: 'Nothing left in the cash balance' };
        const cur = currency.toUpperCase();
        const amountMinor = fromStripeMinorUnits(available, cur);
        const why = type === 'applied_to_payment' ? 'probably an overpayment'
            : type === 'unapplied_from_payment' ? `returned when PaymentIntent ${intentId ?? '?'} was cancelled`
                : 'probably a transfer sent after the order was cancelled or expired';
        Logger.warn(`${formatMinor(amountMinor, cur)} sits unapplied in the Stripe cash balance of ${customerId} (${why}; last bank transfer: order ${latest.orderCode})`, loggerCtx);
        this.alertOnce(`${customerId}:${currency}:${available}:cash`, {
            event: 'bank.stripe_unsettled',
            text: `Checkout Guard: ${formatMinor(amountMinor, cur)} is in the Stripe cash balance of customer ${customerId} without paying for an order (${why}; `
                + `their last bank transfer was for order ${latest.orderCode}, ${latest.state}). Refund it from the Stripe dashboard (Customers → the customer → Cash balance); `
                + 'left there, Stripe applies it to that customer\'s next bank-transfer order, and returns it after 75 days.',
            orderCode: latest.orderCode, amountMinor, currency: cur, channelId: latest.channelId, provider: 'stripe',
        });
        return { status: 200, message: 'Unapplied cash balance alerted' };
    }

    /**
     * Sweep fallback (worker, every ten minutes, only while
     * `bankTransfer.stripe` is enabled): asks Stripe about each open Stripe
     * bank transfer of an order still awaiting payment, and settles those
     * whose PaymentIntent has succeeded, in case the webhook was missed. Shares
     * the expiry sweep's lock but stops starting checks after three minutes,
     * so it never holds the lock into the next sweep; each payment is asked
     * about at most once per ten minutes; a partly funded transfer stays open.
     */
    async syncStripe(now: Date = new Date()): Promise<StripeBankTransferSyncResult> {
        if (!getBankTransferRuntime().stripe) return { checked: 0, settled: 0, awaiting: 0, skipped: 'disabled' };
        const locked = await withDbLock(this.connection.rawConnection, 'bank-sweep', () => this.syncStripeLocked(now));
        if (!locked.acquired) {
            Logger.verbose('Stripe bank-transfer check skipped: another process holds the sweep lock', loggerCtx);
            return { checked: 0, settled: 0, awaiting: 0, skipped: 'locked' };
        }
        return locked.result!;
    }

    private async syncStripeLocked(now: Date): Promise<StripeBankTransferSyncResult> {
        const result: StripeBankTransferSyncResult = { checked: 0, settled: 0, awaiting: 0, skipped: null };
        const startedAt = Date.now();
        const open = await this.findOpenStripeTransfers();
        const openIds = new Set(open.map(r => String(r.paymentId)));
        for (const id of [...this.stripeChecks.keys()]) if (!openIds.has(id)) this.stripeChecks.delete(id);
        const lastAt = (id: ID) => this.stripeChecks.get(String(id))?.at ?? 0;
        const due = open
            .filter(r => now.getTime() - lastAt(r.paymentId) >= STRIPE_CHECK_INTERVAL_MS)
            .sort((a, b) => lastAt(a.paymentId) - lastAt(b.paymentId))
            .slice(0, STRIPE_CHECKS_PER_RUN);
        const seenIntents = new Set<string>();
        for (const row of due) {
            if (Date.now() - startedAt > STRIPE_SYNC_BUDGET_MS) {
                Logger.verbose('Stripe bank-transfer check: time budget used up; the rest is checked on the next run', loggerCtx);
                break;
            }
            const key = String(row.paymentId);
            const seen = this.stripeChecks.get(key);
            this.stripeChecks.set(key, { at: now.getTime(), remaining: seen?.remaining });
            try {
                const payment = await this.loadBankTransferPayment(row.paymentId);
                const paymentIntentId = payment ? stripePaymentIntentIdOf(payment.metadata) : null;
                if (!payment || !paymentIntentId || payment.state !== 'Authorized' || payment.order.state !== 'PaymentAuthorized') continue;
                if (seenIntents.has(paymentIntentId)) continue; // a duplicate payment of an intent handled above
                seenIntents.add(paymentIntentId);
                const live = await this.liveStripeIntent(payment, paymentIntentId, STRIPE_SYNC_CALL_TIMEOUT_MS);
                if (!live) continue;
                result.checked++;
                if (live.status === 'succeeded') {
                    const carriers = await this.paymentsCarrying(payment.order.code, paymentIntentId);
                    if ((await this.settleFromStripe(carriers.length ? carriers : [payment], live, 'sweep')).ok) result.settled++;
                } else if (live.status === 'canceled') {
                    this.alertCancelledAtStripe(payment, live, paymentIntentId, now);
                } else {
                    result.awaiting++;
                    const { remaining } = stripeTransferFunding(live);
                    if (seen?.remaining === undefined || seen.remaining !== remaining) this.logPartFunding(payment.order.code, live);
                    if (remaining !== null) await this.refreshAmountDue(payment, remaining);
                    this.stripeChecks.set(key, { at: now.getTime(), remaining });
                }
            } catch (e: any) {
                Logger.warn(`Stripe check of bank transfer payment ${row.paymentId} failed: ${describeStripeFailure(e)}`, loggerCtx);
            }
        }
        return result;
    }

    /** The intent was cancelled at Stripe while the order still waits: the customer can no longer complete it. */
    private alertCancelledAtStripe(payment: Payment, live: StripeBankTransferIntentLike, paymentIntentId: string, now: Date): void {
        // A cancel of our own commits within seconds; only a cancellation older than that is someone else's.
        const cancelledMs = Number(live.canceled_at) * 1000;
        if (cancelledMs > 0 && now.getTime() - cancelledMs < CANCELLED_AT_STRIPE_GRACE_MS) return;
        const msg = `Stripe PaymentIntent ${paymentIntentId} for order ${payment.order.code} is cancelled at Stripe, but the order still awaits its bank transfer`;
        if (!this.stripeAlerted.has(`${paymentIntentId}:canceled`)) Logger.warn(`${msg}; mark it received or cancel it`, loggerCtx);
        this.alertOnce(`${paymentIntentId}:canceled`, {
            event: 'bank.stripe_unsettled',
            text: `Checkout Guard: ${msg}. The customer can no longer complete it: money they send now stays in their Stripe cash balance. `
                + 'Mark the payment received if they paid you directly, or cancel the order (and refund anything in the cash balance).',
            orderCode: payment.order.code, paymentIntentId, amountMinor: payment.amount, currency: payment.order.currencyCode, provider: 'stripe',
        });
    }

    /**
     * Before the sweep expires a Stripe bank transfer: `'settled'` when Stripe
     * has the money (settled here instead), `'unknown'` when Stripe could not
     * be asked (not expired on this pass; alerted once it is a day overdue),
     * null otherwise (not a Stripe transfer, nothing received, no key, or an
     * intent Stripe says is not on that account: expired as usual, and the
     * cancel reports the intent it could not reach).
     */
    private async stripeBeforeExpiry(payment: Payment, expiresAt: Date, now: Date): Promise<'settled' | 'unknown' | null> {
        const paymentIntentId = stripePaymentIntentIdOf(payment.metadata);
        if (!paymentIntentId) return null;
        let live: StripeBankTransferIntentLike | null;
        try {
            live = await this.liveStripeIntent(payment, paymentIntentId);
        } catch (e) {
            if (isMissingAtStripe(e)) {
                Logger.warn(`Stripe does not know ${paymentIntentId} of order ${payment.order.code} with the channel's key (${describeStripeFailure(e)}); expiring it as usual`, loggerCtx);
                return null;
            }
            Logger.warn(`Bank transfer for order ${payment.order.code} not expired on this pass: Stripe could not be asked about ${paymentIntentId} (${describeStripeFailure(e)})`, loggerCtx);
            if (now.getTime() - expiresAt.getTime() > CHECK_FAILED_ALERT_AFTER_MS) {
                this.alertOnce(`${paymentIntentId}:check_failed`, {
                    event: 'bank.stripe_check_failed',
                    text: `Checkout Guard: the bank transfer for order ${payment.order.code} is more than a day past its pay-by date, but it is not being expired: Stripe could not be asked whether ${paymentIntentId} has been paid (${describeStripeFailure(e)}). `
                        + 'Check the payment in the Stripe dashboard, then mark it received or cancel the order.',
                    orderCode: payment.order.code, paymentIntentId, amountMinor: payment.amount, currency: payment.order.currencyCode, provider: 'stripe',
                });
            }
            return 'unknown';
        }
        // No Stripe key any more: expire it like any other transfer (the cancel then reports the intent it could not reach).
        if (!live) return null;
        if (live.status === 'succeeded') {
            const carriers = await this.paymentsCarrying(payment.order.code, paymentIntentId);
            await this.settleFromStripe(carriers.length ? carriers : [payment], live, 'sweep');
            return 'settled';
        }
        return null;
    }

    /**
     * Settle a transfer Stripe reports as paid, given every payment of the
     * order that carries the intent: the same row lock, state re-read and
     * tracking update as "mark received", for exactly one of them. Nothing is
     * settled (and a human is alerted, since the money is at Stripe) when the
     * intent's payment is already settled, is no longer Authorized, belongs
     * to a cancelled or already paid order, or Stripe received less than it.
     */
    private async settleFromStripe(
        carriers: Payment[], pi: StripeBankTransferIntentLike, source: 'webhook' | 'sweep',
    ): Promise<{ ok: boolean; message: string }> {
        const sorted = [...carriers].sort((a, b) => Number(a.id) - Number(b.id));
        const first = sorted[0];
        const orderCode = first.order.code;
        const cur = first.order.currencyCode;
        noteStripeTransferSucceeded(pi.id);
        const settled = sorted.find(p => p.state === 'Settled');
        const open = sorted.filter(p => p.state === 'Authorized');
        const duplicatesAlert = (keep: Payment, extra: Payment[]) => {
            if (!extra.length) return;
            this.alertOnce(`${pi.id}:duplicates`, {
                event: 'bank.stripe_unsettled',
                text: `Checkout Guard: order ${orderCode} has more than one open bank-transfer payment for the same Stripe transfer ${pi.id}. `
                    + `Payment ${keep.id} is the one settled with it; cancel payment${extra.length > 1 ? 's' : ''} ${extra.map(p => p.id).join(', ')} (the PaymentIntent is left alone).`,
                orderCode, paymentIntentId: pi.id, amountMinor: keep.amount, currency: cur, provider: 'stripe',
            });
        };
        if (settled) {
            if (!settledThroughStripe(settled.metadata)) {
                const msg = `Stripe has received the bank transfer ${pi.id} for order ${orderCode}, but its payment ${settled.id} had already been marked received by hand`;
                Logger.warn(msg, loggerCtx);
                this.alertOnce(`${pi.id}:settled_by_hand`, {
                    event: 'bank.stripe_unsettled',
                    text: `Checkout Guard: ${msg}. If the customer has also paid you directly, they have paid twice: refund one of the payments (this one from the Stripe dashboard).`,
                    orderCode, paymentIntentId: pi.id, amountMinor: settled.amount, currency: cur, provider: 'stripe',
                });
            }
            duplicatesAlert(settled, open);
            return { ok: true, message: `Bank transfer ${pi.id} already settled` };
        }
        const target = open[0];
        const unsettled = (what: string, key: string, advice = 'Refund the customer from the Stripe dashboard, or reinstate the order.') => {
            const msg = `Stripe has received the bank transfer for order ${orderCode} (${pi.id}), but ${what}, so nothing was settled`;
            Logger.warn(msg, loggerCtx);
            this.alertOnce(`${pi.id}:${key}`, {
                event: 'bank.stripe_unsettled',
                text: `Checkout Guard: ${msg}. ${advice}`,
                orderCode, paymentIntentId: pi.id, amountMinor: (target ?? first).amount, currency: cur, provider: 'stripe',
            });
            return { ok: false, message: msg };
        };
        if (!target) return unsettled(`its payment is ${first.state}`, 'unsettled');
        if (target.order.state === 'Cancelled') return unsettled('the order is cancelled', 'unsettled');
        if (PAID_ORDER_STATES.has(String(target.order.state))) {
            return unsettled(`the order is already paid (${target.order.state})`, 'order_paid', 'The customer has probably paid twice: refund one of the payments (this one from the Stripe dashboard).');
        }
        const received = Number(pi.amount_received);
        if (Number.isFinite(received) && fromStripeMinorUnits(received, cur) < target.amount) {
            return unsettled(
                `Stripe received only ${formatMinor(fromStripeMinorUnits(received, cur), cur)} of the payment's ${formatMinor(target.amount, cur)}`,
                'short', 'Check the PaymentIntent in the Stripe dashboard, then mark the payment received or ask the customer for the rest.',
            );
        }
        const ctx = await this.contextForOrder(target.order);
        const result = await this.settleUnderLock(ctx, target.id);
        if ('stale' in result) {
            return result.stale === 'Settled'
                ? { ok: true, message: `Bank transfer ${pi.id} already settled` }
                : { ok: false, message: `Payment ${target.id} is ${result.stale}, not settled` };
        }
        if (isGraphQlErrorResult(result)) {
            const why = String((result as any).paymentErrorMessage || result.message);
            const msg = `Stripe has received the bank transfer for order ${orderCode} (${pi.id}), but settling payment ${target.id} failed: ${why}`;
            Logger.warn(msg, loggerCtx);
            this.alertOnce(`${pi.id}:settle_failed`, {
                event: 'bank.stripe_unsettled',
                text: `Checkout Guard: ${msg}. Mark it received from Checkout Guard → Bank transfers once the order allows it.`,
                orderCode, paymentIntentId: pi.id, amountMinor: target.amount, currency: cur, provider: 'stripe',
            });
            return { ok: false, message: `Settle failed: ${why}` };
        }
        await this.trackSettled(target, ctx.channelId);
        duplicatesAlert(target, open.slice(1));
        Logger.info(`Bank transfer received through Stripe for order ${orderCode} (${pi.id}, ${source}); payment ${target.id} settled`, loggerCtx);
        return { ok: true, message: `Bank transfer ${pi.id} settled for order ${orderCode}` };
    }

    /** The intent as Stripe sees it now; null when the channel has no Stripe key (logged once). Throws on Stripe errors. */
    private async liveStripeIntent(payment: Payment, paymentIntentId: string, timeoutMs = STRIPE_BANK_TRANSFER_TIMEOUT_MS): Promise<StripeBankTransferIntentLike | null> {
        const orderChannel = payment.order?.channels?.find(ch => String(ch.id) !== '1') ?? payment.order?.channels?.[0];
        const channelId = stripeChannelIdOf(payment.metadata) ?? orderChannel?.id;
        const apiKey = channelId !== undefined ? await getStripeKeyForChannelId(this.connection, channelId, { preferOwnMethod: true }) : undefined;
        if (!apiKey) {
            if (!this.stripeAlerted.has(`nokey:${channelId}`)) {
                Logger.warn(`No Stripe secret key on channel ${channelId ?? '?'}: its Stripe bank transfers cannot be checked or cancelled at Stripe`, loggerCtx);
            }
            this.stripeAlerted.add(`nokey:${channelId}`);
            return null;
        }
        return retrievePaymentIntent(apiKey, paymentIntentId, { timeoutMs }) as Promise<StripeBankTransferIntentLike>;
    }

    /**
     * Open (Authorized) bank-transfer payments that carry a Stripe PaymentIntent,
     * on orders still awaiting payment, newest first (an order cancelled or paid
     * some other way is alerted once and never polled again).
     */
    private async findOpenStripeTransfers(): Promise<Array<{ paymentId: ID }>> {
        const codes = await this.bankTransferMethodCodes();
        const rows: Array<{ paymentId: ID; metadata: unknown }> = await this.db.query(
            `SELECT p.id AS paymentId, p.metadata AS metadata
             FROM payment p
             JOIN \`order\` o ON o.id = p.\`orderId\`
             WHERE p.state = 'Authorized' AND o.state = 'PaymentAuthorized' AND p.method IN (${this.placeholders(codes.length)}) AND p.metadata LIKE ?
             ORDER BY p.\`createdAt\` DESC
             LIMIT 500`,
            [...codes, '%paymentIntentId%'],
        );
        return (rows ?? []).filter(r => stripePaymentIntentIdOf(r.metadata) !== null);
    }

    /** Every bank-transfer payment of the order that carries the intent; `orderKnown` is false when the order is not in this database. */
    private async findStripeBackedPayments(orderCode: string, paymentIntentId: string): Promise<{ orderKnown: boolean; payments: Payment[] }> {
        const codes = await this.bankTransferMethodCodes();
        const rows: Array<{ paymentId: ID | null; metadata: unknown }> = await this.db.query(
            `SELECT o.id AS orderId, p.id AS paymentId, p.metadata AS metadata
             FROM \`order\` o
             LEFT JOIN payment p ON p.\`orderId\` = o.id AND p.method IN (${this.placeholders(codes.length)})
             WHERE o.code = ?
             ORDER BY p.id ASC`,
            [...codes, orderCode],
        );
        if (!rows?.length) return { orderKnown: false, payments: [] };
        const payments: Payment[] = [];
        for (const r of rows) {
            if (r.paymentId === null || r.paymentId === undefined || stripePaymentIntentIdOf(r.metadata) !== paymentIntentId) continue;
            const p = await this.loadBankTransferPayment(r.paymentId);
            if (p) payments.push(p);
        }
        return { orderKnown: true, payments };
    }

    private async paymentsCarrying(orderCode: string, paymentIntentId: string): Promise<Payment[]> {
        return (await this.findStripeBackedPayments(orderCode, paymentIntentId)).payments;
    }

    /** The bank-transfer payments whose Stripe customer is `customerId`, newest first (at most 50). */
    private async paymentsOfStripeCustomer(customerId: string): Promise<Array<{
        state: string; orderCode: string; channelId: string; paymentIntentId: string | null;
    }>> {
        const codes = await this.bankTransferMethodCodes();
        // Payment metadata is stored as JSON text, so the key and value appear exactly like this.
        const rows: Array<{ paymentState: string; metadata: unknown; orderCode: string }> = await this.db.query(
            `SELECT p.state AS paymentState, p.metadata AS metadata, o.code AS orderCode
             FROM payment p
             JOIN \`order\` o ON o.id = p.\`orderId\`
             WHERE p.method IN (${this.placeholders(codes.length)}) AND p.metadata LIKE ?
             ORDER BY p.id DESC
             LIMIT 50`,
            [...codes, `%"stripeCustomerId":"${customerId}"%`],
        );
        const out: Array<{ state: string; orderCode: string; channelId: string; paymentIntentId: string | null }> = [];
        for (const r of rows ?? []) {
            const channelId = stripeChannelIdOf(r.metadata);
            if (stripeCustomerIdOf(r.metadata) !== customerId || !channelId) continue;
            out.push({ state: String(r.paymentState), orderCode: r.orderCode, channelId, paymentIntentId: stripePaymentIntentIdOf(r.metadata) });
        }
        return out;
    }

    /**
     * Keep `metadata.public.amountMinor` at what is still due once part has
     * arrived, so the confirmation page and the reminder e-mail ask for the
     * rest, not the full amount again. Only ever lowered (events can arrive out
     * of order), and only while the payment is Authorized.
     */
    private async refreshAmountDue(payment: Payment, remainingStripe: number): Promise<void> {
        try {
            const meta = typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata;
            const pub = meta?.public;
            if (!pub || payment.state !== 'Authorized' || !stripePaymentIntentIdOf(meta)) return;
            const due = fromStripeMinorUnits(remainingStripe, payment.order.currencyCode);
            if (!(due > 0) || !(Number(pub.amountMinor) > due)) return;
            const next = { ...meta, public: { ...pub, amountMinor: due } };
            await this.db.query(`UPDATE payment SET metadata = ? WHERE id = ? AND state = 'Authorized'`, [JSON.stringify(next), payment.id]);
            payment.metadata = next;
            Logger.verbose(`Bank transfer for order ${payment.order.code}: amount still due is now ${formatMinor(due, payment.order.currencyCode)}`, loggerCtx);
        } catch (e: any) {
            Logger.verbose(`Could not update the amount due for payment ${payment.id}: ${e?.message || e}`, loggerCtx);
        }
    }

    private logPartFunding(orderCode: string, pi: StripeBankTransferIntentLike): void {
        const { remaining, received, partlyFunded } = stripeTransferFunding(pi);
        if (!partlyFunded || remaining === null) return;
        const cur = String(pi.currency || '').toUpperCase();
        Logger.info(
            `Bank transfer for order ${orderCode} is partly paid at Stripe (${pi.id}): ${formatMinor(fromStripeMinorUnits(received, cur), cur)} received, `
            + `amount_remaining ${formatMinor(fromStripeMinorUnits(remaining, cur), cur)}; the payment stays open`,
            loggerCtx,
        );
    }

    private alertOnce(key: string, ev: BankTransferOpsEvent): void {
        if (this.stripeAlerted.has(key)) return;
        if (this.stripeAlerted.size > 5000) this.stripeAlerted.clear();
        this.stripeAlerted.add(key);
        notifyBankTransferOps(ev);
    }

    // ── Internals ───────────────────────────────────────────────────────
    private async loadBankTransferPayment(paymentId: ID): Promise<Payment | null> {
        const payment = await this.connection.rawConnection.getRepository(Payment).findOne({
            where: { id: paymentId as any },
            relations: ['order', 'order.channels'],
        });
        if (!payment) return null;
        const codes = await this.bankTransferMethodCodes();
        if (!codes.includes(payment.method)) return null;
        return payment;
    }

    /**
     * An admin-API context for the order's own channel. Payments are not
     * channel-aware, so OrderService checks the order is visible in the
     * context's channel — the request's channel may not be the order's.
     */
    private async contextForOrder(order: Order): Promise<RequestContext> {
        let channel: Channel | undefined = order.channels?.find(ch => String(ch.id) !== '1') ?? order.channels?.[0];
        if (!channel) {
            const rows: Array<{ channelId: ID }> = await this.db.query(
                `SELECT \`channelId\` FROM order_channels_channel WHERE \`orderId\` = ? ORDER BY \`channelId\` DESC`, [order.id],
            );
            const id = rows?.[0]?.channelId;
            channel = id
                ? (await this.connection.rawConnection.getRepository(Channel).findOne({ where: { id: id as any } })) ?? undefined
                : undefined;
        }
        // Pass the TOKEN, not the entity: a Channel loaded through the order
        // relation carries no defaultTaxZone, and every order operation
        // (cancel, settle) recalculates prices → "error.no-active-tax-zone".
        // RequestContextService resolves a token to the fully-loaded channel.
        return this.requestContextService.create({
            apiType: 'admin',
            channelOrToken: channel?.token,
        });
    }

    /** The payment row under `SELECT … FOR UPDATE` inside `tctx`'s transaction. */
    private async lockPayment(tctx: RequestContext, paymentId: ID): Promise<Payment | null> {
        return this.connection.getRepository(tctx, Payment).createQueryBuilder('p')
            .setLock('pessimistic_write').where('p.id = :id', { id: paymentId }).getOne();
    }

    /** Settle in its own transaction with the row locked and the state re-read, or `{ stale }` when it is no longer Authorized. */
    private settleUnderLock(ctx: RequestContext, paymentId: ID) {
        return this.connection.withTransaction(ctx, async tctx => {
            const live = await this.lockPayment(tctx, paymentId);
            if (!live || live.state !== 'Authorized') return { stale: live?.state ?? 'missing' };
            return this.orderService.settlePayment(tctx, paymentId);
        });
    }

    /** The tracking row for a settled transfer (same for "mark received" and Stripe). */
    private async trackSettled(payment: Payment, channelId: ID): Promise<void> {
        await this.ensureTracked(payment, channelId);
        await this.db.query(`UPDATE checkout_guard_bank_transfer SET settledAt = NOW() WHERE paymentId = ?`, [payment.id]);
    }

    private async cancelPaymentAndOrder(ctx: RequestContext, payment: Payment, reason: string): Promise<BankTransferActionResult> {
        const cancelPayment = await this.connection.withTransaction(ctx, async tctx => {
            const live = await this.lockPayment(tctx, payment.id);
            if (!live || live.state !== 'Authorized') return { stale: live?.state ?? 'missing' };
            return this.orderService.cancelPayment(tctx, payment.id);
        });
        if ('stale' in cancelPayment) {
            return { ok: false, error: `payment_not_authorized:${cancelPayment.stale}`, paymentState: String(cancelPayment.stale), orderState: payment.order.state };
        }
        if (isGraphQlErrorResult(cancelPayment)) {
            return { ok: false, error: `cancel_payment_failed: ${cancelPayment.message}`, paymentState: payment.state, orderState: payment.order.state };
        }
        const cancelOrder = await this.orderService.cancelOrder(ctx, { orderId: payment.order.id, reason });
        if (isGraphQlErrorResult(cancelOrder)) {
            return { ok: false, error: `cancel_order_failed: ${cancelOrder.message}`, paymentState: cancelPayment.state, orderState: payment.order.state };
        }
        return { ok: true, paymentState: cancelPayment.state, orderState: cancelOrder.state };
    }

    private async ensureTracked(payment: Payment, channelId: ID, expiresAt?: Date): Promise<void> {
        const details = readBankTransferPublicDetails(payment.metadata);
        const payBy = expiresAt ?? parsePayBy(details)
            ?? new Date(new Date(payment.createdAt).getTime() + getBankTransferRuntime().expiryDays * 86_400_000);
        // Idempotent (primary key on paymentId): a concurrent sweep + admin action cannot throw here.
        await this.db.query(
            `INSERT IGNORE INTO checkout_guard_bank_transfer (paymentId, orderId, orderCode, channelId, amountMinor, currency, payBy)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [payment.id, payment.order.id, payment.order.code, channelId, payment.amount, details?.currency ?? payment.order.currencyCode ?? null, toSqlDateTime(payBy)],
        );
    }
}

/** The channel an admin request is scoped to: null for the default channel (sees everything). */
function scopedChannelId(ctx?: RequestContext): number | null {
    if (!ctx?.channelId) return null;
    if (ctx.channel?.code === '__default_channel__' || String(ctx.channelId) === '1') return null;
    return Number(ctx.channelId);
}

function visibleIn(payment: Payment, ctx?: RequestContext): boolean {
    const scope = scopedChannelId(ctx);
    if (!scope) return true;
    return (payment.order?.channels || []).some(ch => String(ch.id) === String(scope));
}

function toIso(value: string | Date | null | undefined): string | null {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The id of a Stripe object that may arrive expanded. */
function idOf(value: unknown): string | null {
    if (typeof value === 'string') return value;
    const id = (value as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? id : null;
}

/** `YYYY-MM-DD HH:MM:SS` in UTC — accepted by both MariaDB DATETIME and Postgres TIMESTAMP. */
function toSqlDateTime(d: Date): string {
    return d.toISOString().slice(0, 19).replace('T', ' ');
}
