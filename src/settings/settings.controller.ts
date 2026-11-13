import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { Ctx, Logger, Permission, RequestContext } from '@vendure/core';
import type { Response } from 'express';
import { isAdminApiSession } from '@huloglobal/vendure-licence-sdk';
import { CheckoutGuardPlugin, getAdminOverrides, getCardTestingGate, getInitOptions, getOptions } from '../plugin';
import {
    DEFAULT_CARD_TESTING, IpBlockService, currentLimiterStore, normaliseIp, rateLimitBucket, resetFixedWindow,
    resolveCardTestingOptions, resolveMutationRateLimits, loginRule, orderClientIpField,
} from '../guards';
import { STRIPE_HOLD_DEFAULTS } from '../stripe-hold/runtime';
import { DEFAULT_BANK_TRANSFER_EXPIRY_DAYS, DEFAULT_BANK_TRANSFER_REMINDER_AFTER_DAYS } from '../bank-transfer/bank-transfer-runtime';
import { LOGIN_GUARD_DEFAULTS, ORDER_LOOKUP_DEFAULTS, bankEmailsEnabled, resolveLoginGuard } from './admin-settings';
import { SettingsService } from './settings.service';

const loggerCtx = 'CheckoutGuard';
/** With the per-process (memory) store, blocks stored before this process started are no longer enforced. */
const PROCESS_STARTED_AT = Date.now();

type Need = 'read' | 'write' | 'settings';

function deny(ctx: RequestContext, res: Response, need: Need): boolean {
    const perms = need === 'settings' ? [Permission.UpdateSettings] : need === 'write' ? [Permission.UpdateOrder] : [Permission.ReadOrder];
    if (!isAdminApiSession(ctx) || !ctx.userHasPermissions(perms)) {
        res.status(403).json({ error: 'forbidden' });
        return true;
    }
    return false;
}

/** Every editable value as it is in force, defaults resolved, for the Settings form. */
export function editableView(o: ReturnType<typeof getOptions>) {
    const ct = o.cardTesting === false ? null : resolveCardTestingOptions(o.cardTesting);
    const lg = o.loginGuard || {};
    const ol = o.orderLookup || {};
    return {
        rateLimits: { store: o.rateLimits?.store || 'memory', mutations: resolveMutationRateLimits(o.rateLimits?.mutations) },
        cardTesting: {
            enabled: !!ct,
            maxFailedPerIp: (ct || DEFAULT_CARD_TESTING).maxFailedPerIp,
            maxFailedPerOrder: (ct || DEFAULT_CARD_TESTING).maxFailedPerOrder,
            windowMinutes: (ct || DEFAULT_CARD_TESTING).windowMinutes,
            blockMinutes: (ct || DEFAULT_CARD_TESTING).blockMinutes,
            autoOrderGate: o.cardTesting !== false && o.cardTesting?.autoOrderGate === true,
        },
        loginGuard: {
            enabled: lg.enabled === true,
            maxFailures: lg.maxFailures ?? LOGIN_GUARD_DEFAULTS.maxFailures,
            windowMinutes: lg.windowMinutes ?? LOGIN_GUARD_DEFAULTS.windowMinutes,
            apis: lg.apis ?? LOGIN_GUARD_DEFAULTS.apis,
        },
        orderLookup: {
            enabled: ol.enabled === true,
            capacity: ol.capacity ?? ORDER_LOOKUP_DEFAULTS.capacity,
            windowSeconds: ol.windowSeconds ?? ORDER_LOOKUP_DEFAULTS.windowSeconds,
        },
        bankTransfer: {
            expiryDays: o.bankTransfer?.expiryDays ?? DEFAULT_BANK_TRANSFER_EXPIRY_DAYS,
            reminderAfterDays: o.bankTransfer?.reminderAfterDays ?? DEFAULT_BANK_TRANSFER_REMINDER_AFTER_DAYS,
            emails: bankEmailsEnabled(o.bankTransfer?.emails),
        },
        stripe: {
            safetyCaptureDays: o.stripe?.safetyCaptureDays ?? STRIPE_HOLD_DEFAULTS.safetyCaptureDays,
            autoCaptureBelowMinor: o.stripe?.autoCaptureBelowMinor ?? null,
        },
        reconciliation: {
            enabled: o.reconciliation?.enabled !== false,
            lookbackDays: o.reconciliation?.lookbackDays ?? 3,
            amountDrift: o.reconciliation?.amountDrift === true,
        },
        holds: {
            huloPayments: o.holds?.huloPayments === true,
            huloPaymentsSafetyCapture: o.holds?.huloPaymentsSafetyCapture === true,
        },
    };
}

/**
 * Admin-editable settings and the blocked-connection list.
 *
 *   GET  /checkout-guard/admin-settings           what is in force, the code's values, the saved overrides
 *   POST /checkout-guard/admin-settings           save overrides (UpdateSettings)
 *   POST /checkout-guard/admin-settings/reset     back to the code's options (UpdateSettings)
 *   GET  /checkout-guard/blocked                  card-testing blocks and login lockouts in force
 *   POST /checkout-guard/blocked/unblock { ip }   lift one (UpdateOrder)
 */
@Controller('checkout-guard')
export class CheckoutGuardSettingsController {
    constructor(private settings: SettingsService, private blocks: IpBlockService) {}

    @Get('admin-settings')
    async get(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (deny(ctx, res, 'read')) return;
        const init = getInitOptions();
        return res.json({
            editable: init.adminSettings !== false,
            canEdit: init.adminSettings !== false && ctx.userHasPermissions([Permission.UpdateSettings]),
            premium: CheckoutGuardPlugin.hasPremiumAccess(),
            effective: editableView(getOptions()),
            code: editableView(init),
            saved: getAdminOverrides(),
            limiterStoreInUse: currentLimiterStore(),
            orderClientIpField: orderClientIpField(init.orderClientIp),
        });
    }

    @Post('admin-settings')
    async save(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (deny(ctx, res, 'settings')) return;
        if (getInitOptions().adminSettings === false) return res.status(409).json({ message: 'Settings are managed in code (adminSettings: false).' });
        try {
            const saved = await this.settings.save(body?.settings ?? body);
            Logger.info(`Checkout Guard settings saved by user ${ctx.activeUserId}: ${Object.keys(saved).join(', ') || 'none (code defaults)'}`, loggerCtx);
            return res.status(200).json({ ok: true, saved, effective: editableView(getOptions()) });
        } catch (e: any) {
            return res.status(400).json({ message: e?.message || 'Invalid settings' });
        }
    }

    @Post('admin-settings/reset')
    async reset(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (deny(ctx, res, 'settings')) return;
        if (getInitOptions().adminSettings === false) return res.status(409).json({ message: 'Settings are managed in code (adminSettings: false).' });
        await this.settings.reset();
        return res.status(200).json({ ok: true, effective: editableView(getOptions()) });
    }

    @Get('blocked')
    async blocked(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (deny(ctx, res, 'read')) return;
        let rows: Array<{ ip: string; surface: string; failures: number; blockedAt: string; blockedUntil: string }> = [];
        try { rows = await this.blocks.listActive(); } catch { rows = []; }
        if (currentLimiterStore() === 'memory') rows = rows.filter(r => new Date(r.blockedAt).getTime() >= PROCESS_STARTED_AT - 5_000);
        // Blocks this process holds that the table does not (store unavailable): show them too.
        const seen = new Set(rows.map(r => `${r.ip}|${r.surface.startsWith('login') ? 'login' : 'card'}`));
        for (const b of getCardTestingGate().list()) {
            if (seen.has(`${b.ip}|card`)) continue;
            rows.push({ ip: b.ip, surface: b.surface, failures: b.failures, blockedAt: b.blockedAt.toISOString(), blockedUntil: b.blockedUntil.toISOString() });
        }
        return res.json({ items: rows, total: rows.length });
    }

    @Post('blocked/unblock')
    async unblock(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (deny(ctx, res, 'write')) return;
        const raw = String(body?.ip || '').trim().slice(0, 64);
        const ip = normaliseIp(raw.replace(/::\/64$/, '::')) ? raw : null;
        if (!ip) return res.status(400).json({ message: 'Not an IP address' });
        getCardTestingGate().unblock(ip);
        try { await this.blocks.unblock(ip); } catch (e: any) { Logger.warn(`Unblock of ${ip} not stored: ${e?.message || e}`, loggerCtx); }
        // Login lockouts are keyed by connection (IPv4, or IPv6 /64): clear both APIs' current windows.
        const lg = resolveLoginGuard({ ...(getOptions().loginGuard || {}), enabled: true })!;
        const key = ip.endsWith('::/64') ? ip : rateLimitBucket(ip);
        if (key) {
            for (const api of ['admin', 'shop'] as const) await resetFixedWindow(loginRule(api), key, lg.windowMs);
            if (key !== ip) await this.blocks.unblock(key).catch(() => undefined);
        }
        Logger.info(`Checkout Guard: ${ip} unblocked by user ${ctx.activeUserId}`, loggerCtx);
        return res.status(200).json({ ok: true, ip });
    }
}
