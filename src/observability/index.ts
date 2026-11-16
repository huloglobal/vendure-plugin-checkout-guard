/**
 * Module D — Observability.
 *
 * Wire into the plugin with:
 *   controllers: [ObservabilityController]
 *   providers:   [ObservabilityService, OpsAlertService, CounterService, ReconciliationService, AmountDriftSubscriber, BankExpirySubscriber]
 * and from `CheckoutGuardPlugin.init()`:
 *   configureObservability({ getOptions: () => options, hasPremiumAccess: () => CheckoutGuardPlugin.hasPremiumAccess() });
 *
 * Other modules record events through `ObservabilityService` (e.g. the
 * Stripe webhook writes `kind: 'failed'` on `payment_intent.payment_failed`,
 * the safety-capture cron writes `hold_expired`, bank-transfer expiry
 * writes `bank_expired`) and raise alerts through `OpsAlertService.alert()`.
 */
export { ObservabilityController } from './observability.controller';
export { ObservabilityService, isPaymentEventKind } from './observability.service';
export { OpsAlertService, formatMinor, composeOpsAlertEmail } from './ops-alert.service';
export { CounterService, dayKey } from './counter.service';
export { ReconciliationService, ReconciliationRunResult, ReconciliationStatus } from './reconciliation.service';
export { AmountDriftSubscriber } from './amount-drift.subscriber';
export { BankExpirySubscriber } from './bank-expiry.subscriber';
export {
    configureObservability,
    ObservabilityRuntime,
    ObservabilityOptions,
    ObservabilityOpsOptions,
    HOLD_METHOD_DEFAULT,
    BANK_METHOD_CODE,
    holdMethodCode,
} from './runtime';
export { ensureObservabilitySchema, PAYMENT_EVENT_TABLE, FUNNEL_EVENT_TABLE, COUNTER_TABLE } from './schema';
export { summariseFunnel, funnelKey, isFunnelStep, FunnelRowLite } from './funnel';
export { detectAmountDrift, AmountDriftInput, AmountDriftResult } from './amount-drift';
export {
    findOrphanIntents,
    listStripePaymentIntents,
    vendureMetadataOf,
    MatchOptions,
    ListIntentsOptions,
    RECONCILE_STATUSES,
} from './reconciliation';
export {
    PAYMENT_EVENT_KINDS,
    PREMIUM_EVENT_KINDS,
    FUNNEL_STEPS,
    FUNNEL_CHAIN,
    PaymentEventKind,
    PaymentEventInput,
    PaymentEventRow,
    FunnelStep,
    FunnelEventInput,
    FunnelStepSummary,
    FunnelSummary,
    ObservabilitySummary,
    UsageStats,
    StripeIntentLite,
    OrphanCandidate,
} from './types';
