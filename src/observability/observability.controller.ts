import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Ctx, Permission, RequestContext } from '@vendure/core';
import { RateLimiter, isAdminApiSession } from '@huloglobal/vendure-licence-sdk';
import { isFunnelStep } from './funnel';
import { ObservabilityService } from './observability.service';
import { OpsAlertService } from './ops-alert.service';
import { ReconciliationService } from './reconciliation.service';
import { getClientIp } from '../guards/client-ip';
import { runtimeOptions } from './runtime';
import { FUNNEL_STEPS, PAYMENT_EVENT_KINDS } from './types';

/** Admin reads need ReadOrder, writes UpdateOrder. Returns true when the
 *  request was rejected (response already sent). */
function denyUnlessAdmin(ctx: RequestContext, res: Response, write: boolean): boolean {
    const needed = write ? [Permission.UpdateOrder] : [Permission.ReadOrder];
    if (!isAdminApiSession(ctx) || !ctx.userHasPermissions(needed)) {
        res.status(403).json({ error: 'forbidden' });
        return true;
    }
    return false;
}

function str(v: unknown, max: number): string {
    if (typeof v !== 'string') return '';
    const s = v.trim();
    return s.length > max ? s.slice(0, max) : s;
}

const ORDER_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;

@Controller('checkout-guard')
export class ObservabilityController {
    /** Client declines: 10/min per IP. */
    private declineLimiter = new RateLimiter({ capacity: 10, windowMs: 60_000 });
    /** Funnel beacons: 60/min per IP. */
    private funnelLimiter = new RateLimiter({ capacity: 60, windowMs: 60_000 });

    constructor(
        private service: ObservabilityService,
        private ops: OpsAlertService,
        private reconciliation: ReconciliationService,
    ) {}

    /** Trusted proxy header (already stripped by the guards middleware
     *  unless the proxy secret matched) → cf-connecting-ip / x-forwarded-for
     *  from a trusted proxy → req.ip → socket (see `getClientIp`). */
    private ipOf(req: Request): string {
        const o = runtimeOptions().trustedClientIp || {};
        return getClientIp(req, { header: o.header, trustedProxies: o.trustedProxies, trustCloudflareHeader: o.trustCloudflareHeader }) || '';
    }

    // ── Public: storefront-side card decline ─────────────────────────
    /**
     * `POST /checkout-guard/client-decline { orderCode, code, message }`
     * Stripe.js reports inline declines to the browser only (no webhook
     * fires for a `confirmPayment` that fails synchronously), so the
     * storefront relays them here. Always 200 — never reveals whether the
     * order code exists.
     */
    @Post('client-decline')
    async clientDecline(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response, @Body() body: any) {
        const ip = this.ipOf(req);
        if (!this.declineLimiter.allow(`decline:${ip || 'unknown'}`)) {
            return res.status(429).json({ errors: [{ message: 'rate_limited' }] });
        }
        const orderCode = str(body?.orderCode, 64);
        const code = str(body?.code, 64) || 'client_declined';
        const message = str(body?.message, 500) || null;
        const order = ORDER_CODE_RE.test(orderCode) ? await this.service.findOrderByCode(orderCode) : null;
        await this.service.recordPaymentEvent({
            channelId: order?.channelId ?? ctx.channelId ?? 1,
            orderId: order?.id ?? null,
            orderCode: ORDER_CODE_RE.test(orderCode) ? orderCode : null,
            kind: 'client_declined',
            provider: str(body?.provider, 32) || 'stripe',
            providerRef: str(body?.paymentIntentId, 191) || null,
            code,
            message,
            amountMinor: Number.isFinite(Number(body?.amountMinor)) ? Number(body.amountMinor) : null,
            currency: str(body?.currency, 8) || null,
            ip,
        });
        return res.status(200).json({ ok: true });
    }

    // ── Public: checkout funnel beacon ───────────────────────────────
    /**
     * `POST /checkout-guard/funnel { step, orderCode?, sessionId?, detail? }`
     * Fire-and-forget from the storefront; unknown steps are dropped with
     * a 400 so instrumentation bugs surface in the browser console.
     */
    @Post('funnel')
    async funnel(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response, @Body() body: any) {
        const ip = this.ipOf(req);
        if (!this.funnelLimiter.allow(`funnel:${ip || 'unknown'}`)) {
            return res.status(429).json({ errors: [{ message: 'rate_limited' }] });
        }
        const step = body?.step;
        if (!isFunnelStep(step)) {
            return res.status(400).json({ errors: [{ message: 'invalid_step', allowed: FUNNEL_STEPS }] });
        }
        const orderCode = str(body?.orderCode, 64);
        await this.service.recordFunnelEvent({
            channelId: ctx.channelId ?? 1,
            step,
            orderCode: ORDER_CODE_RE.test(orderCode) ? orderCode : null,
            sessionId: str(body?.sessionId, 128) || null,
            detail: str(body?.detail, 500) || null,
            ip,
        });
        return res.status(200).json({ ok: true });
    }

    // ── Admin: payment events ────────────────────────────────────────
    /**
     * The channel an admin read is scoped to: an operator working in a
     * non-default channel only sees that channel; the default channel may
     * pick any channel with `?channelId=` or see everything.
     */
    private scopedChannel(ctx: RequestContext, requested: unknown): number | null {
        const isDefault = !ctx.channelId || ctx.channel?.code === '__default_channel__' || String(ctx.channelId) === '1';
        if (!isDefault) return Number(ctx.channelId);
        const n = requested ? Number(requested) : NaN;
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    /** `GET /checkout-guard/events?kind=&days=&channelId=&orderCode=&limit=` */
    @Get('events')
    async events(@Ctx() ctx: RequestContext, @Res() res: Response, @Query() q: any) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const events = await this.service.listPaymentEvents({
            kind: q?.kind, days: q?.days, channelId: this.scopedChannel(ctx, q?.channelId) ?? undefined, orderCode: q?.orderCode, limit: q?.limit,
        });
        return res.json({ events, kinds: PAYMENT_EVENT_KINDS });
    }

    /** `GET /checkout-guard/summary?channelId=` — dashboard KPIs. */
    @Get('summary')
    async summary(@Ctx() ctx: RequestContext, @Res() res: Response, @Query() q: any) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const summary = await this.service.summary(this.scopedChannel(ctx, q?.channelId));
        const now = new Date();
        const [u30, u7] = await Promise.all([
            this.service.usageStats(new Date(now.getTime() - 30 * 86_400_000), now).catch(() => null),
            this.service.usageStats(new Date(now.getTime() - 7 * 86_400_000), now).catch(() => null),
        ]);
        return res.json({
            ...summary,
            opsConfigured: this.ops.isConfigured(),
            reconciliation: await this.reconciliation.status(),
            // Value metrics for the Overview tiles (store-wide: the counters carry no channel).
            usage: {
                heldValueMinor30d: u30?.heldValuePence ?? 0,
                heldCurrency: u30?.heldCurrency ?? null,
                holdsPlaced30d: u30?.holdsPlaced ?? 0,
                rateLimitRejections7d: u7?.rateLimitRejections ?? 0,
                orderAccessDenied7d: u7?.orderAccessDenied ?? 0,
            },
        });
    }

    /** `GET /checkout-guard/funnel/summary?days=&channelId=` */
    @Get('funnel/summary')
    async funnelSummary(@Ctx() ctx: RequestContext, @Res() res: Response, @Query() q: any) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const summary = await this.service.funnelSummary(q?.days ?? 7, this.scopedChannel(ctx, q?.channelId));
        return res.json(summary);
    }

    /** `POST /checkout-guard/reconcile/run` — run the Stripe reconciliation now (admin, UpdateOrder). */
    @Post('reconcile/run')
    async reconcileRun(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        const result = await this.reconciliation.runOnce({ force: true });
        return res.status(200).json(result);
    }
}
