import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { Ctx, Logger, Permission, RequestContext } from '@vendure/core';

const loggerCtx = 'CheckoutGuard';
import { Response } from 'express';
import { describeLicence, evalInstanceId, performSelfUpdate, selfUpdateEnv, isAdminApiSession } from '@huloglobal/vendure-licence-sdk';
import { CheckoutGuardPlugin, getOptions } from './plugin';
import { CheckoutGuardService, PLUGIN_ID } from './checkout-guard.service';
import { effectiveStripeHoldOptions } from './stripe-hold';
import { getBankTransferRuntime } from './bank-transfer';
import { DEFAULT_MUTATION_RATE_LIMITS, DEFAULT_TRUSTED_CLIENT_IP_HEADER, DEFAULT_TRUSTED_CLIENT_IP_SECRET_HEADER, resolveMutationRateLimits } from './guards';

function denyUnlessAdmin(ctx: RequestContext, res: Response, write: boolean | 'superadmin'): boolean {
    const needed = write === 'superadmin' ? [Permission.SuperAdmin] : write ? [Permission.UpdateOrder] : [Permission.ReadOrder];
    if (!isAdminApiSession(ctx) || !ctx.userHasPermissions(needed)) {
        res.status(403).json({ error: 'forbidden' });
        return true;
    }
    return false;
}

/**
 * Plugin-level admin endpoints: version + update banner, effective
 * settings, and the licence lifecycle (activate / deactivate /
 * buy-from-admin / billing portal). Feature endpoints live in the
 * module controllers under the same `/checkout-guard` prefix.
 */
@Controller('checkout-guard')
export class CheckoutGuardLicenceController {
    constructor(private service: CheckoutGuardService) {}

    @Get('meta')
    async meta(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const updater = CheckoutGuardPlugin.getUpdateChecker();
        const licence = CheckoutGuardPlugin.getLicenceStatus();
        let extras: Awaited<ReturnType<CheckoutGuardService['licenceExtras']>> | null = null;
        try { extras = await this.service.licenceExtras(); } catch { extras = null; }
        return res.json({
            name: CheckoutGuardPlugin.getPackageName(),
            version: CheckoutGuardPlugin.getPackageVersion(),
            update: updater ? updater.getStatus() : null,
            selfUpdate: selfUpdateEnv(),
            licensed: !!licence?.valid,
            licence: describeLicence(licence),
            licenceMessage: licence?.valid ? '' : (licence?.message || 'No licence key configured'),
            tier: licence?.valid ? 'paid' : (CheckoutGuardPlugin.getEvalState()?.active ? 'trial' : 'free'),
            eval: CheckoutGuardPlugin.getEvalState(),
            notice: extras?.notice ?? null,
            premiumFeatures: extras?.premiumFeatures ?? [],
            recentStats: extras?.recentStats ?? [],
            buyUrl: extras?.buyUrl ?? `https://elite.charity/licence/buy/${PLUGIN_ID}`,
        });
    }

    /** Setup checklist (real checks) for the Overview card and the digest tips. */
    @Get('setup')
    async setup(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        try {
            return res.json(await this.service.setup());
        } catch (e: any) {
            Logger.warn(`Setup checklist failed: ${e?.message || e}`, loggerCtx);
            return res.json({ items: [], complete: true });
        }
    }

    /** Three headline figures (7 days) for the dashboard widget. */
    @Get('widget')
    async widget(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        try {
            return res.json(await this.service.widget());
        } catch (e: any) {
            Logger.warn(`Widget payload failed: ${e?.message || e}`, loggerCtx);
            return res.json({ tier: 'free', notice: null, stats: [], route: '/extensions/checkout-guard' });
        }
    }

    // ── Weekly report ────────────────────────────────────────────────

    @Get('digest/settings')
    async digestSettings(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        return res.json(await this.service.digestSettings());
    }

    @Post('digest/settings')
    async digestUpdate(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, 'superadmin')) return;
        const patch: { enabled?: boolean; recipient?: string | null } = {};
        if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
        if (body?.recipient !== undefined) patch.recipient = body.recipient === null ? null : String(body.recipient).slice(0, 320);
        try {
            return res.json(await this.service.updateDigestSettings(patch));
        } catch (e: any) {
            return res.status(400).json({ message: e?.message || 'Invalid settings' });
        }
    }

    @Post('digest/send-test')
    async digestSendTest(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        const to = String(body?.to || '').trim().slice(0, 320);
        if (to && !/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(to)) return res.status(400).json({ message: 'Enter a valid email address' });
        const r = await this.service.digest.sendNow(to || null);
        return res.json({ sent: r.sent, to: r.to, reason: r.reason, subject: r.preview.subject });
    }

    /** This week's report as HTML (opened in a new tab from the admin). */
    @Get('digest/preview')
    async digestPreview(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const mail = await this.service.digestPreview();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(mail.html);
    }

    /** Effective options as the plugin sees them (secrets redacted). */
    @Get('settings')
    async settings(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const o = getOptions();
        const stripe = effectiveStripeHoldOptions();
        const bank = getBankTransferRuntime();
        const ip = o.trustedClientIp || {};
        return res.json({
            premium: CheckoutGuardPlugin.hasPremiumAccess(),
            publicBaseUrl: o.publicBaseUrl,
            stripe: {
                holdMethodCode: stripe.holdMethodCode,
                safetyCaptureDays: stripe.safetyCaptureDays,
                autoCaptureBelowMinor: stripe.autoCaptureBelowMinor ?? null,
                webhookSecretConfigured: !!(o.stripe?.webhookSecret || '').trim() || Object.keys(process.env).some(k => k.startsWith('STRIPE_CG_WEBHOOK_SECRET')),
                webhookRoute: '/checkout-guard/stripe-webhook',
            },
            bankTransfer: { expiryDays: bank.expiryDays, reminderAfterDays: bank.reminderAfterDays },
            reconciliation: { enabled: o.reconciliation?.enabled !== false, lookbackDays: o.reconciliation?.lookbackDays ?? 3 },
            trustedClientIp: {
                header: ip.header || DEFAULT_TRUSTED_CLIENT_IP_HEADER,
                secretHeader: ip.secretHeader || DEFAULT_TRUSTED_CLIENT_IP_SECRET_HEADER,
                secretConfigured: !!(ip.secret || '').trim(),
                trustedProxies: ip.trustedProxies || [],
                trustCloudflareHeader: ip.trustCloudflareHeader ?? (ip.trustedProxies || []).length > 0,
            },
            rateLimits: resolveMutationRateLimits(o.rateLimits?.mutations),
            rateLimitDefaults: DEFAULT_MUTATION_RATE_LIMITS,
            ops: {
                slack: !!o.ops?.slackWebhookUrl, discord: !!o.ops?.discordWebhookUrl, teams: !!o.ops?.teamsWebhookUrl,
                telegram: !!(o.ops?.telegramBotToken && o.ops?.telegramChatId), webhook: !!o.ops?.webhookUrl, email: o.ops?.adminEmail || null,
            },
            orderAccess: { anonymousAccessDuration: o.orderAccess?.anonymousAccessDuration || '2h' },
        });
    }

    /** One-click in-app update: registry-verified install of THIS plugin
     *  via the host's package manager + supervisor restart. */
    @Post('update/run')
    async updateRun(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, 'superadmin')) return;
        const updater = CheckoutGuardPlugin.getUpdateChecker();
        const target = String(body?.version || updater?.getStatus()?.latest || '').trim();
        if (target && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(target)) return res.status(400).json({ ok: false, message: 'Not a valid version.' });
        if (!target) return res.status(400).json({ ok: false, message: 'No target version known yet — the registry check runs daily; try again shortly.' });
        const result = await performSelfUpdate({ packageName: CheckoutGuardPlugin.getPackageName(), targetVersion: target });
        return res.status(result.ok ? 200 : 400).json(result);
    }

    @Post('licence/activate')
    async licenceActivate(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, 'superadmin')) return;
        const key = String(body?.key || '').trim();
        if (!key) return res.status(400).json({ licensed: false, message: 'Paste your licence key first.' });
        const status = CheckoutGuardPlugin.activateRuntimeLicence(key);
        if (!status.valid) return res.status(400).json({ licensed: false, message: status.message || 'Invalid licence key.' });
        await this.service.saveStoredLicenceKey(key);
        return res.json({ licensed: true, message: status.message });
    }

    @Post('licence/deactivate')
    async licenceDeactivate(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, 'superadmin')) return;
        await this.service.clearStoredLicenceKey();
        CheckoutGuardPlugin.deactivateRuntimeLicence();
        return res.json({ licensed: false });
    }

    @Post('licence/purchase-link')
    async licencePurchaseLink(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        const plan = (['monthly', 'annual', 'lifetime'].includes(String(body?.plan)) ? String(body.plan) : 'annual') as 'monthly' | 'annual' | 'lifetime';
        try {
            const r = await this.purchaseClaimClient().createPurchaseLink(plan, String(body?.email || '').trim() || undefined);
            return res.json({ url: r.url, state: 'pending' });
        } catch (e: any) {
            Logger.warn(`Purchase link failed: ${e?.message || e}`, loggerCtx);
            return res.status(500).json({ message: 'Could not start the purchase — try again shortly.' });
        }
    }

    @Get('licence/claim-status')
    async licenceClaimStatus(@Ctx() ctx: RequestContext, @Res() res: Response, @Query('check') check?: string) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const client = this.purchaseClaimClient();
        const st = check ? await client.checkNow() : await client.status();
        return res.json({ ...st, licensed: CheckoutGuardPlugin.isLicensed() });
    }

    @Post('licence/portal-link')
    async licencePortalLink(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        let storedKey: string | null = null;
        try { storedKey = await this.service.loadStoredLicenceKey(); } catch { storedKey = null; }
        const url = await this.purchaseClaimClient().billingPortalUrl(storedKey);
        if (!url) return res.status(404).json({ message: 'No billing portal is available for this licence (lifetime and master licences have nothing to manage; for a key set via the environment, reply to your receipt email for a portal link).' });
        return res.json({ url });
    }

    @Post('eval/remind-me')
    async evalRemindMe(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        const email = String(body?.email || '').trim().slice(0, 320);
        const instanceId = CheckoutGuardPlugin.getEvalInstanceId();
        if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) || !instanceId) return res.status(400).json({ error: 'bad-request' });
        try {
            const base = (process.env.HULO_LICENCE_EVAL_URL || 'https://elite.charity/licence/eval/register').replace(/\/register$/, '');
            const resp = await fetch(`${base}/lead`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ plugin: CheckoutGuardPlugin.getPackageName(), instanceId, email }),
                signal: AbortSignal.timeout(8_000),
            });
            if (!resp.ok) return res.status(502).json({ error: 'upstream', status: resp.status });
            // Remembered as the fallback recipient of the weekly report.
            await this.service.prefs.set('eval.leadEmail', email.toLowerCase());
            return res.json({ ok: true });
        } catch {
            return res.status(502).json({ error: 'unreachable' });
        }
    }

    private purchaseClaimClient() {
        return this.service.initPurchaseClaim({
            packageName: CheckoutGuardPlugin.getPackageName(),
            instanceId: () => evalInstanceId(),
            onLicence: async (key: string) => {
                const status = CheckoutGuardPlugin.activateRuntimeLicence(key);
                if (!status.valid) return false;
                await this.service.saveStoredLicenceKey(key);
                return true;
            },
        });
    }

    async onApplicationBootstrap() {
        await this.purchaseClaimClient().resume().catch(() => undefined);
    }
}
