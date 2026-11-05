import { Logger, PluginCommonModule, ProcessContext, RuntimeVendureConfig, Type, VendurePlugin, TransactionalConnection } from '@vendure/core';
import {
    fingerprintPublicKey, Heartbeat, LicenceStatus, RevocationChecker, UpdateChecker, verifyLicence,
    warnIfIncompatibleVendure, EvaluationClient, EvaluationState, LicenceStore, adapterFor,
} from '@huloglobal/vendure-licence-sdk';
import { ModuleRef } from '@nestjs/core';

import { CheckoutGuardService, PLUGIN_ID } from './checkout-guard.service';
import { CheckoutGuardLicenceController } from './licence.controller';
import {
    stripeHoldPaymentHandler, StripeHoldController, StripeHoldService, StripeHoldCron,
    stripeHoldRawBodyMiddlewareRegistration, configureStripeHold, StripeHoldOptions,
} from './stripe-hold';
import {
    bankTransferPaymentHandler, bankTransferEligibilityChecker, BankTransferController, BankTransferService,
    BankTransferCrons, setBankTransferRuntime,
} from './bank-transfer';
import {
    registerCheckoutGuardCustomFields, trustedClientIpMiddleware, shopApiMutationRateLimitMiddleware,
    SessionHashSubscriber, TrustedClientIpOptions, MutationRateLimitOverrides, setCounterSink,
    CardTestingOptions, setFailureLookup, setCardTestingBlockListener,
} from './guards';
import {
    ObservabilityController, ObservabilityService, OpsAlertService, CounterService, ReconciliationService,
    AmountDriftSubscriber, BankExpirySubscriber, configureObservability, ObservabilityOpsOptions,
} from './observability';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PKG_VERSION: string = require('../package.json').version;
const PKG_NAME = '@huloglobal/vendure-plugin-checkout-guard';

export interface CheckoutGuardPluginOptions {
    /** Public-facing host of the Vendure server. Used in licence domain
     *  matching — must match one of the JWT's `allowedDomains`. */
    publicBaseUrl: string;
    /** JWT licence key from huloglobal.com. Without it the plugin runs in
     *  the FREE tier (see README → Tiers) after the 14-day evaluation. */
    licenceKey?: string;
    /** Stripe hold handling. `webhookSecret` signs `/checkout-guard/stripe-webhook`;
     *  a per-channel `STRIPE_CG_WEBHOOK_SECRET_<CHANNELCODE>` env var overrides it. */
    stripe?: StripeHoldOptions & { webhookSecret?: string };
    /** Bank transfer expiry (default 7 days) and reminder (default 3 days). */
    bankTransfer?: { expiryDays?: number; reminderAfterDays?: number };
    /** Nightly Stripe ↔ Vendure reconciliation (premium). */
    reconciliation?: { enabled?: boolean; lookbackDays?: number };
    /** Trusted client-IP contract for server-side proxies. */
    trustedClientIp?: TrustedClientIpOptions;
    /** Token-bucket limits for Shop API mutations, keyed by client IP. */
    rateLimits?: { mutations?: MutationRateLimitOverrides };
    /** Card-testing gate: failed-attempt caps per IP and per order (default on; `false` disables). */
    cardTesting?: CardTestingOptions | false;
    /** Where alerts go: Slack / Discord / Teams / Telegram / signed webhook / email. */
    ops?: ObservabilityOpsOptions;
    /** Anonymous `orderByCode` window for the session-bound strategy (default `2h`). */
    orderAccess?: { anonymousAccessDuration?: string };
}

const HULO_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoLmNM5UljRqe71drM6lR
Ba5vXrLOcV3GAHkYvnVFQSqdE0avrge/jsD7WdA6x8qQFNRugxQcxDJa2l0+C+BH
SbU9TimGwhA1yusHHfuz9LAXks5IQ48+2e6Pulh7iThXPJUnIKqKZUN5HhL79aaK
vrZKIgSfVhwE5PMPXWZ+Ij5IRf74PLIUn1Er75qhBXlDJ4vF8y8/3owURNC1XiUB
DGElwV/LYNoqAQei4oixe4EAxPGvFi11pgHiGuRxuWckA88y6ZHLt6urfAY9sCkj
kF+2dc2yS3j7lD+SYAaV5LQYYjePP1CYvxCZ7HHRKqthHopxY1hsK2tBtni3f7/c
UwIDAQAB
-----END PUBLIC KEY-----`;

const REVOCATION_URL = process.env.HULO_LICENCE_REVOCATION_URL
    || 'https://elite.charity/licence/revoked.json';

let cachedOptions: CheckoutGuardPluginOptions = { publicBaseUrl: 'http://localhost:3000' };
export function getOptions(): CheckoutGuardPluginOptions { return cachedOptions; }

/**
 * `@huloglobal/vendure-plugin-checkout-guard`
 *
 * The safety layer around Vendure checkout and payments:
 *   • Stripe manual-capture holds that actually place the order
 *     (`stripe-hold` handler + signed webhook, capture / cancel, safety capture)
 *   • Bank transfer with public details, eligibility, auto-expiry and reminders
 *   • Session-bound anonymous `orderByCode`, trusted client IP, mutation rate limits
 *   • Failed-payment / orphan / amount-drift log, nightly Stripe reconciliation,
 *     checkout funnel events and ops alerts
 *   • An admin dashboard for all of it
 *
 * @docsCategory Plugin
 * @category Plugin
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    controllers: [CheckoutGuardLicenceController, StripeHoldController, BankTransferController, ObservabilityController],
    providers: [
        CheckoutGuardService,
        StripeHoldService, StripeHoldCron,
        BankTransferService, BankTransferCrons,
        SessionHashSubscriber,
        ObservabilityService, OpsAlertService, CounterService, ReconciliationService, AmountDriftSubscriber, BankExpirySubscriber,
    ],
    compatibility: '>=3.5.0 <4.0.0',
    configuration: (config: RuntimeVendureConfig) => {
        const options = getOptions();
        // Payment handlers + eligibility checker (idempotent: never push twice).
        const handlers = config.paymentOptions.paymentMethodHandlers;
        for (const h of [stripeHoldPaymentHandler, bankTransferPaymentHandler]) {
            if (!handlers.some(x => x.code === h.code)) handlers.push(h);
        }
        const checkers = config.paymentOptions.paymentMethodEligibilityCheckers || [];
        if (!checkers.some(c => c.code === bankTransferEligibilityChecker.code)) checkers.push(bankTransferEligibilityChecker);
        config.paymentOptions.paymentMethodEligibilityCheckers = checkers;
        // Order custom field for the session-bound lookup.
        registerCheckoutGuardCustomFields(config);
        // Middleware: raw body for the Stripe webhook, trusted client IP, mutation rate limits.
        config.apiOptions.middleware = [
            ...(config.apiOptions.middleware || []),
            stripeHoldRawBodyMiddlewareRegistration,
            trustedClientIpMiddleware(options.trustedClientIp),
            shopApiMutationRateLimitMiddleware(
                { limits: options.rateLimits?.mutations, clientIp: options.trustedClientIp, cardTesting: options.cardTesting },
                config.apiOptions.shopApiPath,
            ),
        ];
        return config;
    },
})
export class CheckoutGuardPlugin {
    private static evalClientInternal: EvaluationClient | null = null;
    static getEvalState(): EvaluationState | null { return CheckoutGuardPlugin.evalClientInternal?.getState() ?? null; }
    static getEvalInstanceId(): string | null { return CheckoutGuardPlugin.evalClientInternal?.getInstanceId() ?? null; }

    /** Licensed installs AND installs inside the 14-day server-anchored
     *  evaluation window get the full feature set. */
    static hasPremiumAccess(): boolean {
        if (CheckoutGuardPlugin.licenceStatus?.valid) return true;
        return !!CheckoutGuardPlugin.evalClientInternal?.getState()?.active;
    }
    static isLicensed(): boolean { return !!CheckoutGuardPlugin.licenceStatus?.valid; }

    static startEvaluation(): void {
        if (!CheckoutGuardPlugin.evalClientInternal) {
            CheckoutGuardPlugin.evalClientInternal = new EvaluationClient({ packageName: PKG_NAME, packageVersion: PKG_VERSION });
            if (CheckoutGuardPlugin.statsProvider) CheckoutGuardPlugin.evalClientInternal.setStatsProvider(CheckoutGuardPlugin.statsProvider);
            CheckoutGuardPlugin.evalClientInternal.start();
        }
    }

    private static statsProvider: (() => Promise<Record<string, number>>) | null = null;

    /** Anonymous usage numbers (last 30 days) sent with the heartbeat and
     *  the evaluation ping, so licensed installs keep reporting after purchase. */
    static setStatsProvider(fn: () => Promise<Record<string, number>>): void {
        CheckoutGuardPlugin.statsProvider = fn;
        CheckoutGuardPlugin.heartbeat?.setStatsProvider(fn);
        CheckoutGuardPlugin.evalClientInternal?.setStatsProvider(fn);
    }

    private static licenceHost = '';

    /** Verify + apply a licence key at runtime (admin-UI activation).
     *  Identical checks to boot-time verification. */
    static activateRuntimeLicence(key: string): LicenceStatus {
        const status = verifyLicence({
            licenceKey: key, pluginId: PLUGIN_ID, host: CheckoutGuardPlugin.licenceHost,
            publicKey: HULO_PUBLIC_KEY, revokedIds: CheckoutGuardPlugin.revocation?.getRevokedIds(),
        });
        if (status.valid) {
            CheckoutGuardPlugin.licenceStatus = status;
            CheckoutGuardPlugin.activeLicenceKey = key;
            CheckoutGuardPlugin.evalClientInternal?.stop();
        }
        return status;
    }

    /** The key currently in force (env/init key, admin activation, purchase
     *  claim or the key restored at boot) — read by the heartbeat on every
     *  ping so the licence server keeps the usage stats under the right jti. */
    private static activeLicenceKey: string | null = null;

    /** Drop an admin-activated key: back to unlicensed + evaluation. */
    static deactivateRuntimeLicence(): void {
        CheckoutGuardPlugin.licenceStatus = {
            valid: false,
            message: 'No licence key configured. The plugin will run in the free tier.',
        } as LicenceStatus;
        CheckoutGuardPlugin.activeLicenceKey = null;
        CheckoutGuardPlugin.startEvaluation();
        CheckoutGuardPlugin.evalClientInternal?.start();
    }

    constructor(private connection: TransactionalConnection, private moduleRef: ModuleRef, private processContext: ProcessContext) {}

    /** Apply an admin-activated licence key persisted in the DB (an
     *  explicitly configured env/init key always wins), then hand the
     *  feature modules their runtime hooks and start the engagement
     *  pieces (usage stats, weekly report on the worker). */
    async onApplicationBootstrap() {
        CheckoutGuardPlugin.wireRuntimes(this.moduleRef);
        if (!CheckoutGuardPlugin.licenceStatus?.valid) {
            try {
                const store = new LicenceStore((sql, params, opts) => adapterFor(this.connection.rawConnection).query(sql, params, opts));
                await store.ensureTable();
                const stored = await store.load(PLUGIN_ID);
                if (stored) {
                    const st = CheckoutGuardPlugin.activateRuntimeLicence(stored);
                    // eslint-disable-next-line no-console
                    if (st.valid) console.log(`[${PKG_NAME}] licence restored from admin activation — ${st.message}`);
                }
            } catch { /* store failures never affect boot */ }
        }
        try {
            const service = this.moduleRef.get(CheckoutGuardService, { strict: false });
            await service.ensureEngagementTables();
            const digest = service.initEngagement({
                getOptions: () => getOptions(),
                getLicenceStatus: () => CheckoutGuardPlugin.getLicenceStatus(),
                getEvalState: () => CheckoutGuardPlugin.getEvalState(),
                hasPremiumAccess: () => CheckoutGuardPlugin.hasPremiumAccess(),
            });
            CheckoutGuardPlugin.setStatsProvider(() => service.evalStats());
            if (this.processContext.isWorker) digest.start();
        } catch (e: any) {
            Logger.warn(`Engagement setup skipped: ${e?.message || e}`, 'CheckoutGuard');
        }
    }

    /** Feature modules never import this class; they read options and the
     *  premium flag through small runtime objects installed here. */
    private static wireRuntimes(moduleRef?: ModuleRef): void {
        const options = getOptions();
        const premium = () => CheckoutGuardPlugin.hasPremiumAccess();
        let ops: OpsAlertService | null = null;
        let events: ObservabilityService | null = null;
        let counters: CounterService | null = null;
        try { ops = moduleRef?.get(OpsAlertService, { strict: false }) ?? null; } catch { ops = null; }
        try { events = moduleRef?.get(ObservabilityService, { strict: false }) ?? null; } catch { events = null; }
        try { counters = moduleRef?.get(CounterService, { strict: false }) ?? null; } catch { counters = null; }
        if (counters) { const c = counters; setCounterSink(name => c.bump(name)); }
        if (events) {
            const e = events;
            setFailureLookup((ip, windowMinutes) => e.countRecentFailures(ip, windowMinutes));
        }
        setCardTestingBlockListener(info => {
            if (!ops) return;
            void ops.alert({
                event: 'payment.card_testing',
                text: `Card-testing gate tripped: ${info.ip} made ${info.failures} failed card attempts — payment mutations refused until ${info.blockedUntil.toISOString()} (first refused: ${info.mutation}).`,
                detail: { ip: info.ip, failures: info.failures, blockedUntil: info.blockedUntil.toISOString(), mutation: info.mutation },
            } as any);
        });
        configureStripeHold({
            getOptions: () => options.stripe || {},
            hasPremiumAccess: premium,
            notifyOps: async ev => { if (ops) void ops.alert(ev as any); },
            recordPaymentEvent: async ev => { if (events) await events.recordPaymentEvent(ev as any); },
        });
        setBankTransferRuntime({
            expiryDays: options.bankTransfer?.expiryDays,
            reminderAfterDays: options.bankTransfer?.reminderAfterDays,
            hasPremiumAccess: premium,
        });
        configureObservability({ getOptions: () => options, hasPremiumAccess: premium });
    }

    private static revocation: RevocationChecker | null = null;
    private static updateChecker: UpdateChecker | null = null;
    private static heartbeat: Heartbeat | null = null;
    private static licenceStatus: LicenceStatus | null = null;

    static getUpdateChecker(): UpdateChecker | null { return CheckoutGuardPlugin.updateChecker; }
    static getPackageVersion(): string { return PKG_VERSION; }
    static getPackageName(): string { return PKG_NAME; }
    static getLicenceStatus(): LicenceStatus | null { return CheckoutGuardPlugin.licenceStatus; }

    static init(options: CheckoutGuardPluginOptions): Type<CheckoutGuardPlugin> {
        cachedOptions = { ...options };
        warnIfIncompatibleVendure({
            pluginPackageName: PKG_NAME,
            pluginPackageVersion: PKG_VERSION,
            supportedRange: { min: '3.5.0', max: '4.0.0' },
        });
        if (!CheckoutGuardPlugin.revocation) {
            CheckoutGuardPlugin.revocation = new RevocationChecker(REVOCATION_URL);
            CheckoutGuardPlugin.revocation.start();
        }
        if (!CheckoutGuardPlugin.updateChecker) {
            CheckoutGuardPlugin.updateChecker = new UpdateChecker(PKG_NAME, PKG_VERSION);
            CheckoutGuardPlugin.updateChecker.start();
        }
        const host = (options.publicBaseUrl || '')
            .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        CheckoutGuardPlugin.licenceHost = host;
        const status = verifyLicence({
            licenceKey: options.licenceKey,
            pluginId: PLUGIN_ID,
            host,
            publicKey: HULO_PUBLIC_KEY,
            revokedIds: CheckoutGuardPlugin.revocation.getRevokedIds(),
        });
        CheckoutGuardPlugin.licenceStatus = status;
        CheckoutGuardPlugin.activeLicenceKey = status.valid ? (options.licenceKey || null) : null;
        if (!status.valid) {
            CheckoutGuardPlugin.startEvaluation();
            // eslint-disable-next-line no-console
            console.warn(
                `[${PKG_NAME}] ${status.message}` +
                ` — Running in FREE tier after the 14-day evaluation: session-bound order lookup, trusted client IP, rate limits, funnel and the bank-transfer handler stay on;` +
                ` Stripe holds, bank-transfer expiry, failed-payment log, reconciliation, drift guard and ops alerts need a licence. Buy at https://elite.charity/licence/buy/${PLUGIN_ID}`,
            );
        }
        if (!CheckoutGuardPlugin.heartbeat) {
            CheckoutGuardPlugin.heartbeat = new Heartbeat({
                packageName: PKG_NAME,
                packageVersion: PKG_VERSION,
                licenceKey: options.licenceKey,
                licenceKeyProvider: () => CheckoutGuardPlugin.activeLicenceKey,
                publicKeyFingerprint: fingerprintPublicKey(HULO_PUBLIC_KEY),
            });
            CheckoutGuardPlugin.heartbeat.start();
        }
        // Runtimes without the Nest services (ops/events attach at bootstrap).
        CheckoutGuardPlugin.wireRuntimes();
        return CheckoutGuardPlugin;
    }

    static uiExtensions = {
        extensionPath: __dirname + '/../ui',
        ngModules: [
            {
                type: 'lazy' as const,
                route: 'checkout-guard',
                ngModuleFileName: 'checkout-guard.module.ts',
                ngModuleName: 'CheckoutGuardModule',
            },
            {
                type: 'shared' as const,
                ngModuleFileName: 'checkout-guard-shared.module.ts',
                ngModuleName: 'CheckoutGuardSharedModule',
            },
        ],
    };
}
