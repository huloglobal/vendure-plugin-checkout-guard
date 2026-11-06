import { Injectable } from '@nestjs/common';
import {
    Channel, ChannelService, ID, LanguageCode, Logger, Order, OrderService, Payment, PaymentMethod, RequestContext, RequestContextService,
    TransactionalConnection, isGraphQlErrorResult,
} from '@vendure/core';
import type { Request } from 'express';
import {
    computeHoldUntil, formatMinor, fromStripeMinorUnits, holdUntilFromMetadata, isPaymentIntentId, parseVendureMetadata,
} from './hold-utils';
import { effectiveStripeHoldOptions, getStripeHoldRuntime, notifyOpsSafe, recordPaymentEventSafe, StripeHoldOpsEvent } from './runtime';
import { retrievePaymentIntent, type StripePaymentIntentLike } from './stripe-api';
import { getHoldMethodCodes, getHoldPaymentMethodForChannel, getStripeKeyForChannelId } from './stripe-key';

const loggerCtx = 'CheckoutGuard:StripeHold';

export interface HoldSummary {
    paymentId: ID;
    orderId: ID;
    orderCode: string;
    orderState: string;
    channelCode?: string;
    customerEmail?: string;
    method: string;
    paymentIntentId: string;
    amount: number;
    currencyCode: string;
    authorisedAt: string;
    expiresAt: string;
    /** True once the safety cron would capture it on its next run. */
    due: boolean;
}

export interface HoldActionResult {
    ok: boolean;
    paymentId: ID;
    state?: string;
    error?: string;
}

export interface WebhookOutcome {
    /** What the controller should tell Stripe. Always 2xx once the
     *  signature has passed — Stripe retries anything else for 3 days. */
    status: number;
    message: string;
}

export interface SafetyCaptureReport {
    scanned: number;
    captured: number;
    failed: number;
    skipped: number;
}

/**
 * Everything the hold module does with orders: turns Stripe webhook
 * events into Authorized payments, lists/captures/cancels holds for the
 * admin, and runs the safety capture that the cron calls.
 *
 * @docsCategory Services
 * @category Services
 */
@Injectable()
export class StripeHoldService {
    private static lastLockedAlertAt = 0;
    /** One in-flight handler per PaymentIntent: duplicate deliveries wait for the first. */
    private inflight = new Map<string, Promise<WebhookOutcome>>();
    private premiumWarned = false;

    constructor(
        private connection: TransactionalConnection,
        private orderService: OrderService,
        private channelService: ChannelService,
        private requestContextService: RequestContextService,
    ) {}

    // ── Premium gate ─────────────────────────────────────────────────────

    premium(): boolean {
        const ok = getStripeHoldRuntime().hasPremiumAccess();
        if (!ok && !this.premiumWarned) {
            this.premiumWarned = true;
            Logger.warn('Stripe holds are a premium feature — add a licence key (or start the 14-day trial) to enable webhook handling, capture/cancel and safety capture.', loggerCtx);
        }
        return ok;
    }

    // ── Context helpers (same shape as @vendure/payments-plugin) ─────────

    async createContext(channelToken: string, languageCode?: string, req?: Request): Promise<RequestContext> {
        return this.requestContextService.create({
            apiType: 'admin',
            channelOrToken: channelToken,
            req: req as any,
            languageCode: languageCode as LanguageCode | undefined,
        });
    }

    async channelForToken(token: string): Promise<Channel | undefined> {
        try {
            return await this.channelService.getChannelFromToken(token);
        } catch {
            return undefined;
        }
    }

    /** Pick the order channel that actually has the payment's method. */
    private async contextForPayment(payment: Payment): Promise<RequestContext | undefined> {
        const order = payment.order;
        const channels = order?.channels || [];
        const methods = await this.connection.rawConnection.getRepository(PaymentMethod)
            .find({ where: { code: payment.method }, relations: ['channels'] });
        const withMethod = channels.find(ch => methods.some(m => (m.channels || []).some(mc => String(mc.id) === String(ch.id))));
        const channel = withMethod || channels.find(ch => ch.code !== '__default_channel__') || channels[0];
        if (!channel) return undefined;
        return this.createContext(channel.token);
    }

    // ── Webhook ──────────────────────────────────────────────────────────

    async handleEvent(event: any, req?: Request): Promise<WebhookOutcome> {
        const type = String(event?.type || '');
        const pi: StripePaymentIntentLike | undefined = event?.data?.object;
        if (!pi || !isPaymentIntentId(pi.id)) {
            return { status: 200, message: 'No payment intent in event, ignored' };
        }
        const meta = parseVendureMetadata(pi.metadata);
        if (!meta) {
            Logger.verbose(`Stripe event ${type} for ${pi.id} carries no Vendure metadata, skipped`, loggerCtx);
            return { status: 200, message: 'Event has no Vendure metadata, skipped' };
        }
        if (!this.premium()) {
            // With Stripe bank transfers on, the endpoint also receives events
            // for ordinary card payments. None of them is a hold to record (and
            // the failed-payment log is premium), so they are acknowledged
            // rather than retried for days, which could get the endpoint disabled.
            if (pi.capture_method !== 'manual' && getStripeHoldRuntime().acknowledgeNonHoldEventsWhileLocked?.()) {
                Logger.verbose(`Stripe event ${type} for ${pi.id} is not a hold; acknowledged while premium is locked`, loggerCtx);
                return { status: 200, message: `Event ${type} is not for a hold; ignored while Checkout Guard premium is locked` };
            }
            // Not 200: Stripe keeps retrying (with back-off, for days) so the
            // hold is attached as soon as a licence is active again.
            const now = Date.now();
            if (now - StripeHoldService.lastLockedAlertAt > 60 * 60 * 1000) {
                StripeHoldService.lastLockedAlertAt = now;
                Logger.error(`Stripe hold ${pi.id} for order ${meta.orderCode} NOT recorded — Checkout Guard premium is locked; answering 503 so Stripe retries`, loggerCtx);
                await notifyOpsSafe({ event: 'hold.webhook_error', text: `Stripe hold ${pi.id} for order ${meta.orderCode} NOT recorded — Checkout Guard premium is locked (licence missing or expired). Stripe will retry; activate a licence.`, orderCode: meta.orderCode, paymentIntentId: pi.id });
            }
            return { status: 503, message: 'Checkout Guard premium locked — retry later' };
        }
        switch (type) {
            case 'payment_intent.amount_capturable_updated':
                return this.onAmountCapturable(pi, meta, req);
            case 'payment_intent.payment_failed':
                return this.onPaymentFailed(pi, meta);
            case 'payment_intent.succeeded':
                return this.onSucceeded(pi);
            case 'payment_intent.canceled':
                return this.onCanceled(pi, meta);
            default:
                Logger.verbose(`Stripe event ${type} for order ${meta.orderCode} not handled here`, loggerCtx);
                return { status: 200, message: `Event ${type} ignored` };
        }
    }

    private onAmountCapturable(pi: StripePaymentIntentLike, meta: NonNullable<ReturnType<typeof parseVendureMetadata>>, req?: Request): Promise<WebhookOutcome> {
        const running = this.inflight.get(pi.id);
        if (running) return running;
        const run = this.onAmountCapturableInner(pi, meta, req).finally(() => this.inflight.delete(pi.id));
        this.inflight.set(pi.id, run);
        return run;
    }

    private async onAmountCapturableInner(pi: StripePaymentIntentLike, meta: NonNullable<ReturnType<typeof parseVendureMetadata>>, req?: Request): Promise<WebhookOutcome> {
        const { orderCode, orderId, channelToken, languageCode } = meta;
        // Ops fan-out (webhooks, SMTP) never runs inside the DB transaction.
        const deferred: StripeHoldOpsEvent[] = [];
        const flush = async () => { for (const ev of deferred.splice(0)) await notifyOpsSafe(ev); };
        if (pi.status !== 'requires_capture' || !(Number(pi.amount_capturable) > 0)) {
            return { status: 200, message: `PaymentIntent ${pi.id} is ${pi.status}, nothing to hold` };
        }
        const channel = await this.channelForToken(channelToken);
        if (!channel) {
            Logger.error(`Unknown channel token in PaymentIntent ${pi.id} metadata (order ${orderCode})`, loggerCtx);
            await notifyOpsSafe({ event: 'hold.webhook_error', text: `Stripe hold ${pi.id} for order ${orderCode}: unknown channel token`, orderCode, paymentIntentId: pi.id });
            return { status: 200, message: 'Unknown channel token' };
        }
        // Cheap dedupe before any Stripe round trip: redeliveries of an
        // already-recorded event are the common case. The in-transaction
        // check below still catches two deliveries racing each other.
        const known = await this.connection.rawConnection.getRepository(Payment).findOne({ where: { transactionId: pi.id } as any });
        if (known) {
            return { status: 200, message: `Hold ${pi.id} already recorded as payment ${known.id} (${known.state})` };
        }
        // Stripe retries for days, so the event can describe a state the
        // intent has long left. Ask Stripe for the live intent BEFORE the
        // transaction: a 15 s API call must never sit on the order row lock.
        const live = await this.liveIntent(channel.id, pi);
        let settleAfterCommit: 'auto' | 'captured' | null = null;
        if (live.status === 'succeeded') {
            // Captured at Stripe (dashboard, an earlier retry) before we recorded
            // the hold: record it and settle it straight away — the money is taken.
            settleAfterCommit = 'captured';
        } else if (live.status === 'canceled') {
            const msg = `PaymentIntent ${pi.id} for order ${orderCode} was cancelled at Stripe (${String((live as any).cancellation_reason || 'no reason')}) before the hold was recorded — no payment added`;
            Logger.warn(msg, loggerCtx);
            await recordPaymentEventSafe({
                kind: 'hold_expired', provider: 'stripe', providerRef: pi.id, orderCode, orderId, channelId: channel.id,
                amountMinor: Number.isFinite(Number(pi.amount)) ? fromStripeMinorUnits(Number(pi.amount), pi.currency) : undefined,
                currency: pi.currency ? pi.currency.toUpperCase() : undefined, message: msg,
            });
            await notifyOpsSafe({ event: 'hold.expired', text: msg, orderCode, paymentIntentId: pi.id, channelCode: channel.code });
            return { status: 200, message: `PaymentIntent ${pi.id} is canceled at Stripe, no hold created` };
        } else if (live.status !== 'requires_capture') {
            return { status: 200, message: `PaymentIntent ${pi.id} is ${live.status} at Stripe, nothing to hold` };
        }
        const capturable = settleAfterCommit === 'captured'
            ? (Number(live.amount_received) > 0 ? Number(live.amount_received) : Number(pi.amount_capturable))
            : Number(live.amount_capturable);
        const outerCtx = await this.createContext(channel.token, languageCode, req);
        let pending: { paymentId: ID; held: number; currency: string; reason: 'auto' | 'captured' } | null = null;
        let outcome: WebhookOutcome;
        try {
            outcome = await this.connection.withTransaction(outerCtx, async ctx => {
                const order = await this.orderService.findOneByCode(ctx, orderCode, ['payments', 'channels']);
                if (!order) {
                    Logger.error(`Order ${orderCode} not found for hold ${pi.id}`, loggerCtx);
                    deferred.push({ event: 'hold.webhook_error', text: `Stripe hold ${pi.id}: order ${orderCode} not found`, orderCode, paymentIntentId: pi.id, channelCode: channel.code });
                    return { status: 200, message: 'Order not found' };
                }
                // Serialise concurrent deliveries of the same event on the order row.
                await this.connection.getRepository(ctx, Order).createQueryBuilder('o').setLock('pessimistic_write').where('o.id = :id', { id: order.id }).getOne();
                if (String(order.id) !== String(orderId)) {
                    Logger.warn(`Order ${orderCode} id ${order.id} does not match metadata orderId ${orderId}; continuing by code`, loggerCtx);
                }
                const existing = await this.connection.getRepository(ctx, Payment).findOne({ where: { transactionId: pi.id } as any });
                if (existing) {
                    return { status: 200, message: `Hold ${pi.id} already recorded as payment ${existing.id} (${existing.state})` };
                }
                if (order.state !== 'ArrangingPayment' && order.state !== 'ArrangingAdditionalPayment') {
                    const t = await this.orderService.transitionToState(ctx, order.id, 'ArrangingPayment');
                    if (isGraphQlErrorResult(t)) {
                        const msg = `Cannot move order ${orderCode} (${order.state}) to ArrangingPayment for hold ${pi.id}: ${t.message}`;
                        Logger.error(msg, loggerCtx);
                        deferred.push({ event: 'hold.webhook_error', text: msg, orderCode, paymentIntentId: pi.id, channelCode: channel.code });
                        return { status: 200, message: 'Order state transition failed' };
                    }
                }
                const method = await getHoldPaymentMethodForChannel(this.connection, channel.id);
                if (!method) {
                    const msg = `No PaymentMethod with handler 'stripe-hold' on channel ${channel.code}; hold ${pi.id} for ${orderCode} left uncaptured`;
                    Logger.error(msg, loggerCtx);
                    deferred.push({ event: 'hold.webhook_error', text: msg, orderCode, paymentIntentId: pi.id, channelCode: channel.code });
                    return { status: 200, message: 'No stripe-hold payment method on channel' };
                }
                const result = await this.orderService.addPaymentToOrder(ctx, order.id, {
                    method: method.code,
                    metadata: {
                        paymentIntentId: pi.id,
                        amountCapturable: capturable,
                        stripeStatus: live.status,
                        latestCharge: typeof live.latest_charge === 'string' ? live.latest_charge : live.latest_charge?.id,
                    },
                });
                if (!(result instanceof Order)) {
                    const msg = `addPaymentToOrder failed for hold ${pi.id} on ${orderCode}: ${(result as any).message}`;
                    Logger.error(msg, loggerCtx);
                    deferred.push({ event: 'hold.webhook_error', text: msg, orderCode, paymentIntentId: pi.id, channelCode: channel.code });
                    return { status: 200, message: 'addPaymentToOrder failed' };
                }
                const payment = (result.payments || []).find(p => p.transactionId === pi.id);
                const held = fromStripeMinorUnits(capturable, result.currencyCode);
                Logger.info(`Hold ${pi.id} recorded on order ${orderCode} as Authorized (${formatMinor(held, result.currencyCode)})`, loggerCtx);
                if (settleAfterCommit !== 'captured') {
                    deferred.push({
                        event: 'hold.authorized', orderCode, paymentIntentId: pi.id, amountMinor: held, currency: result.currencyCode, channelCode: channel.code,
                        text: `Card hold authorised for order ${orderCode}: ${formatMinor(held, result.currencyCode)} (${pi.id}) — capture within ${effectiveStripeHoldOptions().safetyCaptureDays} days`,
                    });
                }
                if (held !== result.totalWithTax) {
                    const msg = `Hold ${pi.id} amount ${formatMinor(held, result.currencyCode)} differs from order ${orderCode} total ${formatMinor(result.totalWithTax, result.currencyCode)}`;
                    Logger.warn(msg, loggerCtx);
                    deferred.push({ event: 'hold.amount_mismatch', text: msg, orderCode, paymentIntentId: pi.id, amountMinor: held, currency: result.currencyCode, channelCode: channel.code });
                }
                const { autoCaptureBelowMinor } = effectiveStripeHoldOptions();
                if (payment && settleAfterCommit === 'captured') {
                    pending = { paymentId: payment.id, held, currency: result.currencyCode, reason: 'captured' };
                } else if (payment && Number.isFinite(Number(autoCaptureBelowMinor)) && held < Number(autoCaptureBelowMinor)) {
                    // Settled AFTER the commit: the Stripe capture call must not
                    // run while this transaction holds the order row lock.
                    pending = { paymentId: payment.id, held, currency: result.currencyCode, reason: 'auto' };
                }
                return { status: 200, message: `Hold ${pi.id} recorded on order ${orderCode}` };
            });
        } catch (e: any) {
            void flush();
            const msg = `Unhandled error recording hold ${pi.id} for ${orderCode}: ${e?.message || e}`;
            Logger.error(msg, loggerCtx, e?.stack);
            await notifyOpsSafe({ event: 'hold.webhook_error', text: msg, orderCode, paymentIntentId: pi.id, channelCode: channel.code });
            // 5xx: Stripe retries, so a transient DB error never loses the hold.
            return { status: 500, message: 'Internal error — retry' };
        }
        if (pending) {
            const p = pending as { paymentId: ID; held: number; currency: string; reason: 'auto' | 'captured' };
            const settleCtx = await this.createContext(channel.token, languageCode, req);
            const settled = await this.settleRecordedHold(settleCtx, p.paymentId);
            const what = p.reason === 'auto' ? 'Auto-capture' : 'Settle of externally captured hold';
            if (!settled.ok) {
                Logger.warn(`${what} of ${pi.id} (${orderCode}) failed: ${settled.error}`, loggerCtx);
                deferred.push({ event: 'hold.capture_failed', text: `${what} failed for ${orderCode}: ${settled.error}`, orderCode, paymentIntentId: pi.id, amountMinor: p.held, currency: p.currency, channelCode: channel.code });
            } else if (p.reason === 'auto') {
                deferred.push({ event: 'hold.auto_captured', text: `Auto-captured ${formatMinor(p.held, p.currency)} for order ${orderCode} (below threshold)`, orderCode, paymentIntentId: pi.id, amountMinor: p.held, currency: p.currency, channelCode: channel.code });
            } else {
                deferred.push({ event: 'hold.captured', text: `Hold ${pi.id} for order ${orderCode} was already captured at Stripe (${formatMinor(p.held, p.currency)}); recorded and settled`, orderCode, paymentIntentId: pi.id, amountMinor: p.held, currency: p.currency, channelCode: channel.code });
            }
        }
        // Ops notifications must never hold Stripe's webhook response.
        void flush();
        return outcome;
    }

    /**
     * The intent as Stripe sees it now. Falls back to the event payload
     * when the channel has no Stripe key or the lookup fails — the event
     * is signed, so it is a safe (if possibly stale) description.
     */
    private async liveIntent(channelId: ID, pi: StripePaymentIntentLike): Promise<StripePaymentIntentLike> {
        const apiKey = await getStripeKeyForChannelId(this.connection, channelId);
        if (!apiKey) {
            Logger.verbose(`No Stripe key on channel ${channelId}; recording hold ${pi.id} from the event payload`, loggerCtx);
            return pi;
        }
        try {
            const live = await retrievePaymentIntent(apiKey, pi.id, { timeoutMs: 10_000 });
            return live && live.id === pi.id ? live : pi;
        } catch (e: any) {
            Logger.warn(`Could not retrieve ${pi.id} from Stripe (${e?.message || e}); recording hold from the event payload`, loggerCtx);
            return pi;
        }
    }

    /** Settle a just-recorded hold in its own (short) transaction. */
    private async settleRecordedHold(ctx: RequestContext, paymentId: ID): Promise<{ ok: true; state: string } | { ok: false; error: string }> {
        try {
            const settled = await this.connection.withTransaction(ctx, tctx => this.orderService.settlePayment(tctx, paymentId));
            if (isGraphQlErrorResult(settled)) return { ok: false, error: String((settled as any).paymentErrorMessage || settled.message) };
            return { ok: true, state: settled.state };
        } catch (e: any) {
            return { ok: false, error: e?.message || String(e) };
        }
    }

    private async onPaymentFailed(pi: StripePaymentIntentLike, meta: NonNullable<ReturnType<typeof parseVendureMetadata>>): Promise<WebhookOutcome> {
        const channel = await this.channelForToken(meta.channelToken);
        const err = pi.last_payment_error || undefined;
        const message = err?.message || 'unknown error';
        const code = err?.decline_code || err?.code || undefined;
        Logger.warn(`Payment for order ${meta.orderCode} failed: ${message}${code ? ` (${code})` : ''}`, loggerCtx);
        await recordPaymentEventSafe({
            kind: 'failed', provider: 'stripe', providerRef: pi.id, code, message,
            amountMinor: Number.isFinite(Number(pi.amount)) ? fromStripeMinorUnits(Number(pi.amount), pi.currency) : undefined,
            currency: pi.currency ? pi.currency.toUpperCase() : undefined,
            orderCode: meta.orderCode, orderId: meta.orderId, channelId: channel?.id,
        });
        await notifyOpsSafe({
            event: 'payment.failed', orderCode: meta.orderCode, paymentIntentId: pi.id, channelCode: channel?.code,
            amountMinor: Number.isFinite(Number(pi.amount)) ? fromStripeMinorUnits(Number(pi.amount), pi.currency) : undefined,
            currency: pi.currency ? pi.currency.toUpperCase() : undefined,
            text: `Card payment failed for order ${meta.orderCode}: ${message}${code ? ` (${code})` : ''}`,
        });
        return { status: 200, message: 'Payment failure recorded' };
    }

    /** A manual-capture PI captured outside Vendure (Stripe dashboard):
     *  settle the local Authorized payment so the order follows. Automatic
     *  PIs belong to Vendure's own Stripe webhook and are ignored. */
    private async onSucceeded(pi: StripePaymentIntentLike): Promise<WebhookOutcome> {
        if (pi.capture_method !== 'manual') {
            return { status: 200, message: 'Automatic-capture intent, handled by the Stripe plugin' };
        }
        const payment = await this.findHoldPayment(pi.id);
        if (!payment || payment.state !== 'Authorized') {
            return { status: 200, message: payment ? `Payment already ${payment.state}` : 'No local hold for this intent' };
        }
        const ctx = await this.contextForPayment(payment);
        if (!ctx) return { status: 200, message: 'No channel for order' };
        const r = await this.capture(ctx, payment.id, 'stripe');
        return { status: 200, message: r.ok ? `Hold ${pi.id} settled after external capture` : `Settle failed: ${r.error}` };
    }

    private async onCanceled(pi: StripePaymentIntentLike, meta: NonNullable<ReturnType<typeof parseVendureMetadata>>): Promise<WebhookOutcome> {
        const payment = await this.findHoldPayment(pi.id);
        if (!payment || payment.state !== 'Authorized') {
            return { status: 200, message: payment ? `Payment already ${payment.state}` : 'No local hold for this intent' };
        }
        const reason = String((pi as any).cancellation_reason || '');
        const expired = reason === 'automatic';
        const ctx = await this.contextForPayment(payment);
        if (!ctx) return { status: 200, message: 'No channel for order' };
        const r = await this.cancel(ctx, payment.id, expired ? 'expired' : 'stripe');
        if (expired) {
            await recordPaymentEventSafe({
                kind: 'hold_expired', provider: 'stripe', providerRef: pi.id, orderCode: meta.orderCode, orderId: payment.order?.id,
                channelId: ctx.channelId, amountMinor: payment.amount, currency: payment.order?.currencyCode,
                message: 'Authorisation expired at Stripe before capture',
            });
            await notifyOpsSafe({ event: 'hold.expired', text: `Card hold for order ${meta.orderCode} expired at Stripe before it was captured (${pi.id})`, orderCode: meta.orderCode, paymentIntentId: pi.id, amountMinor: payment.amount, currency: payment.order?.currencyCode });
        }
        return { status: 200, message: r.ok ? `Hold ${pi.id} cancelled locally` : `Cancel failed: ${r.error}` };
    }

    // ── Admin surface ───────────────────────────────────────────────────

    async findHoldPayment(paymentIntentId: string): Promise<Payment | undefined> {
        const codes = await getHoldMethodCodes(this.connection);
        if (!codes.length) return undefined;
        const p = await this.connection.rawConnection.getRepository(Payment).createQueryBuilder('p')
            .leftJoinAndSelect('p.order', 'o')
            .leftJoinAndSelect('o.channels', 'ch')
            .where('p.transactionId = :tx', { tx: paymentIntentId })
            .andWhere('p.method IN (:...codes)', { codes })
            .orderBy('p.id', 'DESC')
            .getOne();
        return p || undefined;
    }

    /** Authorized hold payments visible in the ctx channel. */
    async listHolds(ctx: RequestContext, opts: { includeDue?: boolean } = {}): Promise<HoldSummary[]> {
        const codes = await getHoldMethodCodes(this.connection);
        if (!codes.length) return [];
        const qb = this.connection.getRepository(ctx, Payment).createQueryBuilder('p')
            .leftJoinAndSelect('p.order', 'o')
            .leftJoinAndSelect('o.customer', 'c')
            .leftJoinAndSelect('o.channels', 'ch')
            .where('p.state = :state', { state: 'Authorized' })
            .andWhere('p.method IN (:...codes)', { codes })
            .orderBy('p.createdAt', 'ASC');
        const rows = await qb.getMany();
        const { safetyCaptureDays } = effectiveStripeHoldOptions();
        const now = new Date();
        const chan = String(ctx.channelId ?? '');
        return rows
            .filter(p => !chan || (p.order?.channels || []).some(ch => String(ch.id) === chan))
            .map(p => this.toSummary(p, safetyCaptureDays, now))
            .filter(s => opts.includeDue === undefined ? true : (opts.includeDue ? s.due : !s.due));
    }

    private toSummary(p: Payment, safetyCaptureDays: number, now: Date): HoldSummary {
        const authorisedAt = p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt as any);
        const expiresAt = holdUntilFromMetadata(p.metadata) || computeHoldUntil(authorisedAt, safetyCaptureDays);
        const order = p.order;
        const storeChannel = (order?.channels || []).find(ch => ch.code !== '__default_channel__') || (order?.channels || [])[0];
        return {
            paymentId: p.id,
            orderId: order?.id,
            orderCode: order?.code || '',
            orderState: order?.state || '',
            channelCode: storeChannel?.code,
            customerEmail: order?.customer?.emailAddress,
            method: p.method,
            paymentIntentId: p.transactionId,
            amount: p.amount,
            currencyCode: order?.currencyCode || '',
            authorisedAt: authorisedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            due: expiresAt.getTime() <= now.getTime(),
        };
    }

    private async lockPayment(tctx: RequestContext, paymentId: ID): Promise<Payment | null> {
        return this.connection.getRepository(tctx, Payment).createQueryBuilder('p')
            .setLock('pessimistic_write').where('p.id = :id', { id: paymentId }).getOne();
    }

    private async loadHold(ctx: RequestContext, paymentId: ID): Promise<{ payment?: Payment; error?: string }> {
        const codes = await getHoldMethodCodes(this.connection);
        const payment = await this.connection.getRepository(ctx, Payment).findOne({ where: { id: paymentId } as any, relations: ['order', 'order.channels'] });
        if (!payment) return { error: 'payment_not_found' };
        if (!codes.includes(payment.method)) return { error: 'not_a_stripe_hold' };
        const chan = String(ctx.channelId ?? '');
        if (chan && !(payment.order?.channels || []).some(ch => String(ch.id) === chan)) return { error: 'payment_not_found' };
        return { payment };
    }

    /** Capture (settle) an Authorized hold. `by` is only for the audit trail. */
    async capture(ctx: RequestContext, paymentId: ID, by: 'admin' | 'cron' | 'stripe' = 'admin'): Promise<HoldActionResult> {
        const { payment, error } = await this.loadHold(ctx, paymentId);
        if (!payment) return { ok: false, paymentId, error };
        if (payment.state !== 'Authorized') return { ok: false, paymentId, state: payment.state, error: `payment_is_${payment.state.toLowerCase()}` };
        const orderCode = payment.order?.code || '?';
        const currency = payment.order?.currencyCode || '';
        // The request ctx proves the caller may see the order; the payment
        // method lives on the ORDER's channel, so act in that channel.
        const actx = (await this.contextForPayment(payment)) ?? ctx;
        try {
            // Row lock + state re-read: the hourly safety capture (worker), a
            // Stripe `succeeded` webhook (server) and an admin click can overlap.
            const result = await this.connection.withTransaction(actx, async tctx => {
                const live = await this.lockPayment(tctx, paymentId);
                if (!live || live.state !== 'Authorized') return { stale: live?.state ?? 'missing' };
                return this.orderService.settlePayment(tctx, paymentId);
            });
            if ('stale' in result) {
                const st = String(result.stale);
                if (st === 'Settled' && by !== 'admin') return { ok: true, paymentId, state: st };
                return { ok: false, paymentId, state: st, error: `payment_is_${st.toLowerCase()}` };
            }
            if (isGraphQlErrorResult(result)) {
                const msg = (result as any).paymentErrorMessage || result.message;
                Logger.warn(`Capture of hold ${payment.transactionId} (${orderCode}) by ${by} failed: ${msg}`, loggerCtx);
                await notifyOpsSafe({ event: 'hold.capture_failed', text: `Capture failed for order ${orderCode} (${by}): ${msg}`, orderCode, paymentIntentId: payment.transactionId, amountMinor: payment.amount, currency });
                if (/cancelled at Stripe|expired/i.test(String(msg))) {
                    await recordPaymentEventSafe({ kind: 'hold_expired', provider: 'stripe', providerRef: payment.transactionId, orderCode, orderId: payment.order?.id, channelId: ctx.channelId, amountMinor: payment.amount, currency, message: String(msg) });
                }
                return { ok: false, paymentId, state: payment.state, error: String(msg) };
            }
            await notifyOpsSafe({
                event: by === 'cron' ? 'hold.safety_captured' : 'hold.captured', orderCode, paymentIntentId: payment.transactionId, amountMinor: payment.amount, currency,
                text: `${by === 'cron' ? 'Safety-captured' : 'Captured'} ${formatMinor(payment.amount, currency)} for order ${orderCode} (${by})`,
            });
            return { ok: true, paymentId, state: result.state };
        } catch (e: any) {
            Logger.error(`Capture of hold ${payment.transactionId} (${orderCode}) threw: ${e?.message || e}`, loggerCtx);
            await notifyOpsSafe({ event: 'hold.capture_failed', text: `Capture threw for order ${orderCode}: ${e?.message || e}`, orderCode, paymentIntentId: payment.transactionId });
            return { ok: false, paymentId, state: payment.state, error: e?.message || String(e) };
        }
    }

    /** Release an Authorized hold (cancels the PaymentIntent). The order is
     *  left for the admin to cancel — releasing funds and cancelling the
     *  order are separate decisions. */
    async cancel(ctx: RequestContext, paymentId: ID, by: 'admin' | 'stripe' | 'expired' = 'admin'): Promise<HoldActionResult> {
        const { payment, error } = await this.loadHold(ctx, paymentId);
        if (!payment) return { ok: false, paymentId, error };
        if (payment.state !== 'Authorized') return { ok: false, paymentId, state: payment.state, error: `payment_is_${payment.state.toLowerCase()}` };
        const orderCode = payment.order?.code || '?';
        const currency = payment.order?.currencyCode || '';
        const actx = (await this.contextForPayment(payment)) ?? ctx;
        try {
            const result = await this.connection.withTransaction(actx, async tctx => {
                const live = await this.lockPayment(tctx, paymentId);
                if (!live || live.state !== 'Authorized') return { stale: live?.state ?? 'missing' };
                return this.orderService.cancelPayment(tctx, paymentId);
            });
            if ('stale' in result) {
                const st = String(result.stale);
                if (st === 'Cancelled' && by !== 'admin') return { ok: true, paymentId, state: st };
                return { ok: false, paymentId, state: st, error: `payment_is_${st.toLowerCase()}` };
            }
            if (isGraphQlErrorResult(result)) {
                const msg = (result as any).paymentErrorMessage || result.message;
                Logger.warn(`Release of hold ${payment.transactionId} (${orderCode}) by ${by} failed: ${msg}`, loggerCtx);
                await notifyOpsSafe({ event: 'hold.cancel_failed', text: `Release failed for order ${orderCode} (${by}): ${msg}`, orderCode, paymentIntentId: payment.transactionId });
                return { ok: false, paymentId, state: payment.state, error: String(msg) };
            }
            if (by !== 'expired') {
                await notifyOpsSafe({ event: 'hold.cancelled', text: `Released hold of ${formatMinor(payment.amount, currency)} for order ${orderCode} (${by})`, orderCode, paymentIntentId: payment.transactionId, amountMinor: payment.amount, currency });
            }
            return { ok: true, paymentId, state: result.state };
        } catch (e: any) {
            Logger.error(`Release of hold ${payment.transactionId} (${orderCode}) threw: ${e?.message || e}`, loggerCtx);
            await notifyOpsSafe({ event: 'hold.cancel_failed', text: `Release threw for order ${orderCode}: ${e?.message || e}`, orderCode, paymentIntentId: payment.transactionId });
            return { ok: false, paymentId, state: payment.state, error: e?.message || String(e) };
        }
    }

    // ── Safety capture (cron) ───────────────────────────────────────────

    /** Capture every Authorized hold past its `holdUntil` so the card
     *  authorisation never lapses uncollected. Runs across all channels. */
    async safetyCapture(now: Date = new Date()): Promise<SafetyCaptureReport> {
        const report: SafetyCaptureReport = { scanned: 0, captured: 0, failed: 0, skipped: 0 };
        if (!this.premium()) return report;
        const codes = await getHoldMethodCodes(this.connection);
        if (!codes.length) return report;
        const { safetyCaptureDays } = effectiveStripeHoldOptions();
        const rows = await this.connection.rawConnection.getRepository(Payment).createQueryBuilder('p')
            .leftJoinAndSelect('p.order', 'o')
            .leftJoinAndSelect('o.channels', 'ch')
            .where('p.state = :state', { state: 'Authorized' })
            .andWhere('p.method IN (:...codes)', { codes })
            .orderBy('p.createdAt', 'ASC')
            .getMany();
        report.scanned = rows.length;
        for (const p of rows) {
            const authorisedAt = p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt as any);
            const due = holdUntilFromMetadata(p.metadata) || computeHoldUntil(authorisedAt, safetyCaptureDays);
            if (due.getTime() > now.getTime()) { report.skipped++; continue; }
            const ctx = await this.contextForPayment(p);
            if (!ctx) { report.failed++; Logger.warn(`Safety capture: no channel for payment ${p.id}`, loggerCtx); continue; }
            if (p.order && p.order.state === 'Cancelled') {
                // Never charge a cancelled order: release the funds instead.
                const rel = await this.cancel(ctx, p.id, 'expired');
                if (rel.ok) report.skipped++; else report.failed++;
                continue;
            }
            const r = await this.capture(ctx, p.id, 'cron');
            if (r.ok) report.captured++; else report.failed++;
        }
        if (report.captured || report.failed) {
            Logger.info(`Safety capture: ${report.captured} captured, ${report.failed} failed, ${report.skipped} not yet due`, loggerCtx);
        }
        return report;
    }
}
