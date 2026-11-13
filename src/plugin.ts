import { Logger, PluginCommonModule, ProcessContext, RuntimeVendureConfig, Type, VendurePlugin, TransactionalConnection } from '@vendure/core';
import {
    fingerprintPublicKey, Heartbeat, LicenceStatus, RevocationChecker, UpdateChecker, verifyLicence,
    warnIfIncompatibleVendure, EvaluationClient, EvaluationState, LicenceStore, adapterFor,
} from '@huloglobal/vendure-licence-sdk';
import { APP_INTERCEPTOR, ModuleRef } from '@nestjs/core';
import * as vendureCore from '@vendure/core';

import { CheckoutGuardService, PLUGIN_ID } from './checkout-guard.service';
import { CheckoutGuardLicenceController } from './licence.controller';
import {
    stripeHoldPaymentHandler, StripeHoldController, StripeHoldService, StripeHoldCron,
    stripeHoldRawBodyMiddlewareRegistration, configureStripeHold, StripeHoldOptions,
} from './stripe-hold';
import {
    bankTransferPaymentHandler, bankTransferEligibilityChecker, BankTransferController, BankTransferService,
    BankTransferCrons, setBankTransferRuntime, getBankTransferRuntime, normaliseStripeBankTransferOptions, StripeBankTransferOptions,
    BankTransferEmailSubscriber, setBankEmailRuntime,
} from './bank-transfer';
import {
    registerCheckoutGuardCustomFields, trustedClientIpMiddleware, shopApiMutationRateLimitMiddleware,
    SessionHashSubscriber, TrustedClientIpOptions, MutationRateLimitOverrides, setCounterSink,
    CardTestingOptions, setFailureLookup, setCardTestingBlockListener, CardTestingGate, DEFAULT_CARD_TESTING,
    resolveCardTestingOptions, setCardTestingBlockStore, IpBlockService, CheckoutGuardGraphqlInterceptor, setGraphqlGuardRuntime,
    OrderClientIpSubscriber, OrderClientIpOptions, registerOrderClientIpField, orderClientIpField, setOrderClientIpRuntime,
    readOrderClientIp, LimiterStoreKind, DatabaseLimiterBackend, CacheLimiterBackend, ensureRateTable, setLimiterBackends, currentLimiterStore,
} from './guards';
import { SettingsService } from './settings/settings.service';
import { CheckoutGuardSettingsController } from './settings/settings.controller';
import {
    AdminSettings, HoldSourcesOptions, LoginGuardOptions, OrderLookupLimitOptions, bankEmailsEnabled, mergeAdminSettings,
} from './settings/admin-settings';
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
    /** Bank transfer expiry (default 7 days) and reminder (default 3 days). `stripe: { enabled: true }`
     *  (opt-in) gives GBP orders the customer's Stripe virtual account and reference instead of the
     *  payment method's own details, and settles them when Stripe receives the money. `emails: true`
     *  (premium, opt-in) sends the reminder and expiry e-mails to the customer. See the README. */
    bankTransfer?: { expiryDays?: number; reminderAfterDays?: number; stripe?: StripeBankTransferOptions; emails?: boolean };
    /** Nightly Stripe ↔ Vendure reconciliation (premium). `amountDrift: true` (opt-in) also flags known
     *  intents whose Stripe amount differs from the Vendure payment. */
    reconciliation?: { enabled?: boolean; lookbackDays?: number; amountDrift?: boolean };
    /** Trusted client-IP contract for server-side proxies. */
    trustedClientIp?: TrustedClientIpOptions;
    /** Limits for Shop API mutations, keyed by client connection. `store` (default `memory`):
     *  `database` or `cache` share the counters across processes and restarts. */
    rateLimits?: { mutations?: MutationRateLimitOverrides; store?: LimiterStoreKind };
    /** Card-testing gate: failed-attempt caps per IP and per order (default on; `false` disables).
     *  `autoOrderGate: true` (opt-in) refuses card payment mutations on an order past the cap
     *  without the host's Stripe hook. */
    cardTesting?: (CardTestingOptions & { autoOrderGate?: boolean }) | false;
    /** Login brute-force guard for the Admin and Shop API `login` / `authenticate` mutations (opt-in). */
    loginGuard?: LoginGuardOptions;
    /** Shop API `orderByCode` lookups per client connection (opt-in). */
    orderLookup?: OrderLookupLimitOptions;
    /** Store the shopper's client IP on the order (opt-in; registers Order custom field `cgClientIp`
     *  unless `fieldName` names one the host already has). Needs a migration with `synchronize: false`. */
    orderClientIp?: boolean | OrderClientIpOptions;
    /** Premium hold sources besides Stripe holds: HULO Payments for Vendure manual-capture payments. */
    holds?: HoldSourcesOptions;
    /** Admin Settings tab may override these options (default `true`). `false`: the tab is read-only
     *  and stored overrides are ignored. */
    adminSettings?: boolean;
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
let adminOverrides: AdminSettings = {};
let effectiveOptions: CheckoutGuardPluginOptions = cachedOptions;
/** Effective options: the `init()` options with the admin's saved settings on top. */
export function getOptions(): CheckoutGuardPluginOptions { return effectiveOptions; }
/** The `init()` options exactly as the host passed them (the defaults the Settings tab starts from). */
export function getInitOptions(): CheckoutGuardPluginOptions { return cachedOptions; }
/** The admin's saved overrides in force. */
export function getAdminOverrides(): AdminSettings { return adminOverrides; }
function recomputeOptions(): void {
    effectiveOptions = cachedOptions.adminSettings === false ? cachedOptions : mergeAdminSettings(cachedOptions as any, adminOverrides) as CheckoutGuardPluginOptions;
}

/** One card-testing gate shared by the Shop API middleware and the admin blocked list. */
const cardTestingGate = new CardTestingGate(DEFAULT_CARD_TESTING);
export function getCardTestingGate(): CardTestingGate { return cardTestingGate; }

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
    controllers: [CheckoutGuardLicenceController, CheckoutGuardSettingsController, StripeHoldController, BankTransferController, ObservabilityController],
    providers: [
        CheckoutGuardService,
        StripeHoldService, StripeHoldCron,
        BankTransferService, BankTransferCrons,
        SessionHashSubscriber,
        ObservabilityService, OpsAlertService, CounterService, ReconciliationService, AmountDriftSubscriber, BankExpirySubscriber,
        SettingsService, IpBlockService, OrderClientIpSubscriber, BankTransferEmailSubscriber,
        { provide: APP_INTERCEPTOR, useClass: CheckoutGuardGraphqlInterceptor },
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
        // Order custom field for the session-bound lookup, and (opt-in) the client IP.
        registerCheckoutGuardCustomFields(config);
        registerOrderClientIpField(config, getInitOptions().orderClientIp);
        // Middleware: raw body for the Stripe webhook, trusted client IP, mutation rate limits.
        config.apiOptions.middleware = [
            ...(config.apiOptions.middleware || []),
            stripeHoldRawBodyMiddlewareRegistration,
            trustedClientIpMiddleware(options.trustedClientIp),
            shopApiMutationRateLimitMiddleware(
                {
                    limits: options.rateLimits?.mutations, clientIp: options.trustedClientIp, cardTesting: options.cardTesting,
                    // Re-read on every request so the admin Settings tab applies without a restart.
                    getLimits: () => getOptions().rateLimits?.mutations,
                    getCardTesting: () => getOptions().cardTesting,
                    gate: cardTestingGate,
                },
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
        await this.startSharedState();
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
            // The weekly report is premium (0.4.0): the loop only ticks while premium is active.
            if (this.processContext.isWorker) service.startDigestLoop(digest);
        } catch (e: any) {
            Logger.warn(`Engagement setup skipped: ${e?.message || e}`, 'CheckoutGuard');
        }
    }

    /** Admin settings, the shared limiter store and the shared block list. Fail-soft. */
    private async startSharedState(): Promise<void> {
        const db = () => adapterFor(this.connection.rawConnection);
        try {
            await ensureRateTable(db());
        } catch (e: any) {
            Logger.warn(`Rate-limit table not created (${e?.message || e}); the database store falls back to memory`, 'CheckoutGuard');
        }
        let cache: CacheLimiterBackend | undefined;
        try {
            const CacheService = (vendureCore as any).CacheService;
            const svc = CacheService ? this.moduleRef.get(CacheService, { strict: false }) : null;
            if (svc) cache = new CacheLimiterBackend(svc);
        } catch { cache = undefined; }
        setLimiterBackends({ database: new DatabaseLimiterBackend(db), cache }, () => getOptions().rateLimits?.store || 'memory');
        try {
            const blocks = this.moduleRef.get(IpBlockService, { strict: false });
            await blocks.ensureTable();
            setCardTestingBlockStore(blocks, () => currentLimiterStore() !== 'memory');
        } catch (e: any) {
            Logger.warn(`Blocked-connection table not created (${e?.message || e}); blocks stay per process`, 'CheckoutGuard');
        }
        if (getInitOptions().adminSettings === false) return;
        try {
            const settings = this.moduleRef.get(SettingsService, { strict: false });
            await settings.start(next => CheckoutGuardPlugin.applyAdminSettings(next, this.moduleRef));
        } catch (e: any) {
            Logger.warn(`Admin settings not loaded (${e?.message || e}); the code's options apply`, 'CheckoutGuard');
        }
    }

    /** Apply saved admin settings over the init options and re-wire the runtimes. */
    static applyAdminSettings(next: AdminSettings, moduleRef?: ModuleRef): void {
        adminOverrides = next || {};
        recomputeOptions();
        CheckoutGuardPlugin.wireRuntimes(moduleRef ?? CheckoutGuardPlugin.moduleRefInternal ?? undefined);
    }

    private static moduleRefInternal: ModuleRef | null = null;

    /** Feature modules never import this class; they read options and the
     *  premium flag through small runtime objects installed here. */
    private static wireRuntimes(moduleRef?: ModuleRef): void {
        if (moduleRef) CheckoutGuardPlugin.moduleRefInternal = moduleRef;
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
            setFailureLookup((ip, windowMinutes, since) => e.countRecentFailures(ip, windowMinutes, since));
        }
        setCardTestingBlockListener(info => {
            if (!ops) return;
            void ops.alert({
                event: 'payment.card_testing',
                text: `Card-testing gate tripped: ${info.ip} made ${info.failures} failed card attempts — payment mutations refused until ${info.blockedUntil.toISOString()} (first refused: ${info.mutation}).`,
                detail: { ip: info.ip, failures: info.failures, blockedUntil: info.blockedUntil.toISOString(), mutation: info.mutation },
            } as any);
        });
        const ipField = orderClientIpField(getInitOptions().orderClientIp);
        let connection: TransactionalConnection | null = null;
        try { connection = moduleRef?.get(TransactionalConnection, { strict: false }) ?? null; } catch { connection = null; }
        setOrderClientIpRuntime({ field: () => ipField, clientIp: () => getOptions().trustedClientIp || {} });
        configureStripeHold({
            getOptions: () => getOptions().stripe || {},
            hasPremiumAccess: premium,
            notifyOps: async ev => { if (ops) void ops.alert(ev as any); },
            recordPaymentEvent: async ev => { if (events) await events.recordPaymentEvent(ev as any); },
            // Stripe bank transfers share the hold webhook and need payment_intent.succeeded on it.
            acknowledgeNonHoldEventsWhileLocked: () => !!getBankTransferRuntime().stripe,
            holdSources: () => ({
                huloPayments: getOptions().holds?.huloPayments === true,
                huloPaymentsSafetyCapture: getOptions().holds?.huloPaymentsSafetyCapture === true,
            }),
            orderClientIp: async (orderCode: string) => {
                if (!ipField || !connection || !orderCode) return null;
                const order = await connection.rawConnection.getRepository(vendureCore.Order).findOne({ where: { code: orderCode } });
                return readOrderClientIp(order);
            },
        });
        setBankTransferRuntime({
            expiryDays: options.bankTransfer?.expiryDays,
            reminderAfterDays: options.bankTransfer?.reminderAfterDays,
            hasPremiumAccess: premium,
            stripe: normaliseStripeBankTransferOptions(options.bankTransfer?.stripe),
            notifyOps: async ev => { if (ops) void ops.alert(ev); },
        });
        setBankEmailRuntime({
            enabled: () => bankEmailsEnabled(getOptions().bankTransfer?.emails),
            hasPremiumAccess: premium,
            send: async (to, mail) => {
                if (!ops) throw new Error('mail transport not ready');
                await ops.sendMail(to, mail);
            },
            storeName: () => (getOptions().publicBaseUrl || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
        });
        configureObservability({ getOptions: () => getOptions(), hasPremiumAccess: premium });
        setGraphqlGuardRuntime({
            loginGuard: () => getOptions().loginGuard,
            orderLookup: () => getOptions().orderLookup,
            autoOrderGate: () => {
                const ct = getOptions().cardTesting;
                if (!ct || ct.autoOrderGate !== true) return null;
                return resolveCardTestingOptions(ct);
            },
            clientIp: () => getOptions().trustedClientIp || {},
            countOrderFailures: async (orderCode, windowMinutes) => events ? events.countRecentFailuresForOrder(orderCode, windowMinutes) : 0,
            onLoginLockout: info => {
                let blocks: IpBlockService | null = null;
                try { blocks = moduleRef?.get(IpBlockService, { strict: false }) ?? CheckoutGuardPlugin.moduleRefInternal?.get(IpBlockService, { strict: false }) ?? null; } catch { blocks = null; }
                void blocks?.save({ ip: info.ip, failures: info.failures, blockedAt: new Date(), blockedUntil: info.until, surface: `login:${info.api}` });
                if (ops) void ops.alert({ event: 'security.login_lockout', text: `Login guard: ${info.api} logins from ${info.ip} refused until ${info.until.toISOString()} after ${info.failures} failed attempts.`, detail: { ip: info.ip, api: info.api, failures: info.failures } } as any);
            },
        });
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
        recomputeOptions();
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
                ` — Running in FREE tier after the 14-day evaluation: the Stripe hold list with capture and release, session-bound order lookup, trusted client IP, rate limits, the card-testing and login guards, the decline log, funnel and the bank-transfer handler stay on;` +
                ` auto/safety capture, bank-transfer expiry and e-mails, reconciliation, drift guard, ops alerts and the weekly report need a licence. Buy at https://elite.charity/licence/buy/${PLUGIN_ID}`,
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
