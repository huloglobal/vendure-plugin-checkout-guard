/**
 * `@huloglobal/vendure-plugin-checkout-guard` — public exports.
 *
 * `CheckoutGuardPlugin` registers the payment handlers, the Stripe hold
 * webhook, the guards middleware, the observability services and the
 * admin UI. Hosts wire `SessionBoundOrderByCodeAccessStrategy` into
 * `orderOptions.orderByCodeAccessStrategy` and, for storefront proxies,
 * `getClientIp` / the trusted-header contract.
 */
export { CheckoutGuardPlugin, CheckoutGuardPluginOptions, getOptions } from './plugin';
export { CheckoutGuardService, PLUGIN_ID } from './checkout-guard.service';
export * from './stripe-hold';
export * from './bank-transfer';
export * from './guards';
export * from './observability';
// Both modules expose a `formatMinor`; the Stripe-hold one is the public helper.
export { formatMinor } from './stripe-hold';
export { fanOutOpsEvent, OpsChannels, OpsEvent } from './ops-notify';
export { SettingsService, SETTINGS_PREF_KEY } from './settings/settings.service';
export {
    sanitiseAdminSettings, mergeAdminSettings, resolveLoginGuard, resolveOrderLookup, AdminSettings, LoginGuardOptions,
    OrderLookupLimitOptions, HoldSourcesOptions,
} from './settings/admin-settings';
