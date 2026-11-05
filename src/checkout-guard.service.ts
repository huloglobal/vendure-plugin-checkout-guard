import { Injectable } from '@nestjs/common';
import { Logger, TransactionalConnection } from '@vendure/core';
import {
    LicenceStore, PurchaseClaimClient, adapterFor, PluginPrefs, WeeklyDigest, WeeklyDigestSettings, DigestMail,
    describeLicence, licenceLifecycleNotice, formatStat, smtpTransportFromEnv, LicenceStatus, EvaluationState,
} from '@huloglobal/vendure-licence-sdk';
import { ObservabilityService, OpsAlertService, UsageStats, BANK_METHOD_CODE, holdMethodCode } from './observability';
import { CardTestingOptions, resolveCardTestingOptions } from './guards';
import {
    ADMIN_ROUTE, BUY_URL, PLUGIN_NAME, PREMIUM_FEATURES, SHORT_ID, SetupItem, buildSetupItems, headlineStats,
    setupTips, toDigestStats, toStatRecord,
} from './engagement';

export const PLUGIN_ID = SHORT_ID;

const loggerCtx = 'CheckoutGuard';
const DAY_MS = 86_400_000;

/** Accessors the plugin installs at bootstrap (this file never imports the plugin class). */
export interface EngagementHooks {
    getOptions: () => {
        publicBaseUrl?: string;
        stripe?: { webhookSecret?: string };
        trustedClientIp?: { secret?: string; trustedProxies?: string[] };
        cardTesting?: CardTestingOptions | false;
    };
    getLicenceStatus: () => LicenceStatus | null;
    getEvalState: () => EvaluationState | null;
    hasPremiumAccess: () => boolean;
}

export interface WidgetPayload {
    tier: 'paid' | 'trial' | 'free';
    notice: { kind: string; message: string; daysLeft: number } | null;
    stats: Array<{ label: string; value: string }>;
    route: string;
}

/**
 * Licence persistence, buy-from-admin auto-install and the merchant
 * engagement pieces (usage stats for the licence server, the weekly
 * report, the setup checklist, the dashboard widget). The feature modules
 * never touch this; the controller and the plugin class call in.
 *
 * @docsCategory Services
 * @category Services
 */
@Injectable()
export class CheckoutGuardService {
    constructor(
        private connection: TransactionalConnection,
        private observability: ObservabilityService,
        private ops: OpsAlertService,
    ) {}

    private get db() {
        return adapterFor(this.connection.rawConnection);
    }

    /**
     * Card-testing verdict for the host's `paymentIntentCreateParams` hook
     * (official Stripe plugin) or any custom payment flow: refuse to create
     * another payment attempt when the order, or the client IP, has hit the
     * configured failed-attempt cap inside the window. Never throws.
     */
    async cardTestingVerdict(input: { orderCode?: string | null; ip?: string | null }): Promise<{
        blocked: boolean; reason: 'order' | 'ip' | null; failures: number; message: string | null;
    }> {
        const opts = resolveCardTestingOptions(this.hooks?.getOptions().cardTesting);
        if (!opts) return { blocked: false, reason: null, failures: 0, message: null };
        try {
            if (opts.maxFailedPerOrder > 0 && input.orderCode) {
                const n = await this.observability.countRecentFailuresForOrder(input.orderCode, opts.windowMinutes);
                if (n >= opts.maxFailedPerOrder) {
                    Logger.warn(`Card-testing gate: no new payment attempt for order ${input.orderCode} (${n} failures in ${opts.windowMinutes} min)`, loggerCtx);
                    return { blocked: true, reason: 'order', failures: n, message: 'Too many failed payment attempts on this order. Please contact us to complete your purchase.' };
                }
            }
            if (opts.maxFailedPerIp > 0 && input.ip) {
                const n = await this.observability.countRecentFailures(input.ip, opts.windowMinutes);
                if (n >= opts.maxFailedPerIp) {
                    Logger.warn(`Card-testing gate: no new payment attempt from ${input.ip} (${n} failures in ${opts.windowMinutes} min)`, loggerCtx);
                    return { blocked: true, reason: 'ip', failures: n, message: 'Too many failed payment attempts. Please try again later or contact us.' };
                }
            }
        } catch { /* fail open: a counting error must not block checkout */ }
        return { blocked: false, reason: null, failures: 0, message: null };
    }

    private licenceStore = new LicenceStore((sql, params, opts) => this.db.query(sql, params, opts));

    private purchaseClaim: PurchaseClaimClient | null = null;

    /** Hooks are supplied by the controller so this file never imports the plugin class. */
    initPurchaseClaim(hooks: { packageName: string; instanceId: () => string | null; onLicence: (key: string) => Promise<boolean> }): PurchaseClaimClient {
        if (!this.purchaseClaim) {
            this.purchaseClaim = new PurchaseClaimClient({ ...hooks, query: (sql, params, opts) => this.db.query(sql, params, opts) });
        }
        return this.purchaseClaim;
    }

    async loadStoredLicenceKey(): Promise<string | null> {
        await this.licenceStore.ensureTable();
        return this.licenceStore.load(PLUGIN_ID);
    }

    async saveStoredLicenceKey(key: string): Promise<void> {
        await this.licenceStore.ensureTable();
        await this.licenceStore.save(PLUGIN_ID, key);
    }

    async clearStoredLicenceKey(): Promise<void> {
        await this.licenceStore.clear(PLUGIN_ID);
    }

    // ── Engagement: prefs, stats, digest, checklist, widget ──────────

    readonly prefs = new PluginPrefs((sql, params, opts) => this.db.query(sql, params, opts), PLUGIN_ID);
    private hooks: EngagementHooks | null = null;
    private digestInternal: WeeklyDigest | null = null;

    /** Install the plugin accessors and build the digest. Idempotent. */
    initEngagement(hooks: EngagementHooks): WeeklyDigest {
        this.hooks = hooks;
        if (!this.digestInternal) {
            this.digestInternal = new WeeklyDigest({
                pluginId: PLUGIN_ID,
                pluginName: PLUGIN_NAME,
                prefs: this.prefs,
                collect: (from, to) => this.collectDigest(from, to),
                send: (to, mail) => this.sendDigest(to, mail),
                defaultRecipient: () => this.defaultRecipient(),
            });
        }
        return this.digestInternal;
    }

    /** Create the shared prefs table (next to the licence store). Fail-soft. */
    async ensureEngagementTables(): Promise<void> {
        await this.licenceStore.ensureTable().catch(() => undefined);
        await this.prefs.ensureTable();
    }

    get digest(): WeeklyDigest {
        if (!this.digestInternal) throw new Error('Checkout Guard engagement is not initialised yet');
        return this.digestInternal;
    }

    tier(): 'paid' | 'trial' | 'free' {
        const licence = this.hooks?.getLicenceStatus() ?? null;
        if (licence?.valid) return 'paid';
        return this.hooks?.getEvalState()?.active ? 'trial' : 'free';
    }

    adminUrl(): string | null {
        const base = (this.hooks?.getOptions().publicBaseUrl || '').trim().replace(/\/+$/, '');
        return base ? `${base}/admin/extensions/${ADMIN_ROUTE}` : null;
    }

    /** Usage counters for `[from, to)`; never throws. */
    async usageStats(from: Date, to: Date): Promise<UsageStats> {
        try {
            return await this.observability.usageStats(from, to);
        } catch (e: any) {
            Logger.warn(`Usage stats unavailable: ${e?.message || e}`, loggerCtx);
            return {
                holdsPlaced: 0, holdsCaptured: 0, holdsCancelled: 0, heldValuePence: 0, bankTransfersConfirmed: 0,
                rateLimitRejections: 0, orderAccessDenied: 0, orphansFound: 0, cardTestingBlocked: 0, heldCurrency: null,
            };
        }
    }

    /** Last-30-day numbers for the heartbeat and evaluation pings (numbers only, no PII). */
    async evalStats(): Promise<Record<string, number>> {
        const to = new Date();
        return toStatRecord(await this.usageStats(new Date(to.getTime() - 30 * DAY_MS), to));
    }

    /** Extra fields for `GET /checkout-guard/meta` (licence banner). */
    async licenceExtras(): Promise<{ notice: ReturnType<typeof licenceLifecycleNotice>; premiumFeatures: string[]; recentStats: Array<{ label: string; value: string }>; buyUrl: string }> {
        const licence = describeLicence(this.hooks?.getLicenceStatus() ?? null);
        const notice = licenceLifecycleNotice(licence, this.hooks?.getEvalState() ?? null, PLUGIN_ID);
        const to = new Date();
        const stats = await this.usageStats(new Date(to.getTime() - 30 * DAY_MS), to);
        return {
            notice,
            premiumFeatures: PREMIUM_FEATURES,
            recentStats: headlineStats(stats, 3).map(s => ({ label: s.label, value: formatStat(s) })),
            buyUrl: BUY_URL,
        };
    }

    /** Real checks behind the setup checklist card. */
    async setup(): Promise<{ items: SetupItem[]; complete: boolean }> {
        const o = this.hooks?.getOptions() || {};
        const ip = o.trustedClientIp || {};
        const [holdCodes, bankCodes] = await Promise.all([
            this.observability.methodCodesForHandler(holdMethodCode()).catch(() => [] as string[]),
            this.observability.methodCodesForHandler(BANK_METHOD_CODE).catch(() => [] as string[]),
        ]);
        return buildSetupItems({
            publicBaseUrl: o.publicBaseUrl || '',
            stripeWebhookSecretConfigured: !!(o.stripe?.webhookSecret || '').trim()
                || Object.keys(process.env).some(k => k.startsWith('STRIPE_CG_WEBHOOK_SECRET')),
            holdMethodCodes: holdCodes,
            bankMethodCodes: bankCodes,
            trustedClientIpSecretConfigured: !!(ip.secret || '').trim(),
            trustedProxiesConfigured: (ip.trustedProxies || []).length > 0,
            opsConfigured: this.ops.isConfigured(),
        });
    }

    /** Three headline figures for the dashboard widget (last 7 days). */
    async widget(): Promise<WidgetPayload> {
        const to = new Date();
        const stats = await this.usageStats(new Date(to.getTime() - 7 * DAY_MS), to);
        const rows = toDigestStats(stats);
        const head = headlineStats(stats, 3);
        // Pad a quiet week with the most useful zero rows so the widget always shows three figures.
        for (const key of ['holdsPlaced', 'heldValuePence', 'rateLimitRejections', 'orderAccessDenied', 'bankTransfersConfirmed']) {
            if (head.length >= 3) break;
            const r = rows.find(x => x.key === key);
            if (r && !head.includes(r)) head.push(r);
        }
        const licence = describeLicence(this.hooks?.getLicenceStatus() ?? null);
        const notice = licenceLifecycleNotice(licence, this.hooks?.getEvalState() ?? null, PLUGIN_ID);
        return {
            tier: this.tier(),
            notice: notice ? { kind: notice.kind, message: notice.message, daysLeft: notice.daysLeft } : null,
            stats: head.slice(0, 3).map(s => ({ label: this.shortLabel(s.key), value: formatStat(s) })),
            route: `/extensions/${ADMIN_ROUTE}`,
        };
    }

    private shortLabel(key: string): string {
        switch (key) {
            case 'heldValuePence': return 'Held value (7d)';
            case 'holdsPlaced': return 'Holds placed (7d)';
            case 'holdsCaptured': return 'Holds captured (7d)';
            case 'holdsCancelled': return 'Holds released (7d)';
            case 'bankTransfersConfirmed': return 'Bank transfers confirmed (7d)';
            case 'rateLimitRejections': return 'Rate-limit rejections (7d)';
            case 'orderAccessDenied': return 'Denied order lookups (7d)';
            case 'orphansFound': return 'Orphaned charges (7d)';
            default: return key;
        }
    }

    // ── Weekly report internals ──────────────────────────────────────

    private async collectDigest(from: Date, to: Date) {
        const prevFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));
        const [current, previous, setup] = await Promise.all([
            this.usageStats(from, to),
            this.usageStats(prevFrom, from),
            this.setup().catch(() => ({ items: [] as SetupItem[], complete: true })),
        ]);
        const adminUrl = this.adminUrl();
        return {
            stats: toDigestStats(current, previous),
            tips: setupTips(setup.items, adminUrl),
            tier: this.tier(),
            licence: describeLicence(this.hooks?.getLicenceStatus() ?? null),
            evalState: this.hooks?.getEvalState() ?? null,
            adminUrl,
            premiumFeatures: PREMIUM_FEATURES,
            settingsHint: 'Change the recipient or stop this weekly report in Admin → Sales → Checkout Guard → Settings → Weekly report.',
        };
    }

    /** The ops SMTP transport first (same env as the alerts), else the SDK env transport. */
    private async sendDigest(to: string, mail: DigestMail): Promise<void> {
        if (this.ops.hasSmtp()) {
            await this.ops.sendMail(to, mail);
            return;
        }
        const t = smtpTransportFromEnv();
        if (!t) throw new Error('No SMTP transport: set SMTP_SERVER, SMTP_USER and SMTP_PASSWORD (and SMTP_FROM) on the host');
        await t.sendMail({ to, subject: mail.subject, text: mail.text, html: mail.html });
    }

    /** `ops.adminEmail` → licence customer → trial lead (pref `eval.leadEmail`) → null. */
    async defaultRecipient(): Promise<string | null> {
        const ops = this.ops.adminEmail();
        if (ops) return ops;
        const customer = describeLicence(this.hooks?.getLicenceStatus() ?? null)?.customer;
        if (customer) return customer;
        return (await this.prefs.get('eval.leadEmail')) || null;
    }

    async digestSettings(): Promise<WeeklyDigestSettings> { return this.digest.settings(); }
    async updateDigestSettings(patch: { enabled?: boolean; recipient?: string | null }): Promise<WeeklyDigestSettings> { return this.digest.updateSettings(patch); }

    /** Week-to-date preview without sending. */
    async digestPreview(): Promise<DigestMail> {
        const r = await this.digest.sendNow('');
        return r.preview;
    }
}
