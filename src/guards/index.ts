/**
 * Module C — guards: session-bound order lookup, trusted client IP and
 * Shop API mutation rate limits. Everything here is FREE-tier.
 *
 * Wiring (plugin.ts `configuration` hook):
 * ```ts
 * registerCheckoutGuardCustomFields(config);
 * config.apiOptions.middleware.push(
 *     trustedClientIpMiddleware(options.trustedClientIp),
 *     shopApiMutationRateLimitMiddleware({ limits: options.rateLimits?.mutations, clientIp: options.trustedClientIp }, config.apiOptions.shopApiPath),
 * );
 * ```
 * plus `SessionHashSubscriber` in the plugin's `providers`, and in the host:
 * `orderOptions.orderByCodeAccessStrategy = new SessionBoundOrderByCodeAccessStrategy(options.orderAccess?.anonymousAccessDuration ?? '2h')`.
 */

export { GUARDS_LOGGER_CTX } from './constants';
export { bumpCounter, setCounterSink } from './counters';
export {
    CardTestingGate, DEFAULT_CARD_TESTING, cardTestingBlockedBody, resolveCardTestingOptions,
    setCardTestingBlockListener, setFailureLookup,
} from './card-testing';
export type {
    CardTestingBlockInfo, CardTestingBlockListener, CardTestingOptions, FailureLookup, ResolvedCardTestingOptions,
} from './card-testing';
export type { CounterSink, GuardCounterName } from './counters';
export {
    CG_SESSION_HASH_COLUMN,
    CG_SESSION_HASH_FIELD,
    cgSessionHashCustomField,
    decideSessionHashWrite,
    hashSessionToken,
    hashesEqual,
    parseDuration,
    readStoredSessionHash,
    registerCheckoutGuardCustomFields,
} from './session-hash';
export type { SessionHashDecisionInput } from './session-hash';
export { SessionBoundOrderByCodeAccessStrategy } from './session-bound-order-access.strategy';
export type { SessionBoundOrderAccessOptions } from './session-bound-order-access.strategy';
export { SessionHashSubscriber } from './session-hash.subscriber';
export {
    DEFAULT_TRUSTED_CLIENT_IP_HEADER,
    DEFAULT_TRUSTED_CLIENT_IP_SECRET_HEADER,
    TRUSTED_CLIENT_IP_ENV,
    TRUSTED_PROXY_REQUEST_FLAG,
    clientIpFromForwardedFor,
    createTrustedClientIpHandler,
    getClientIp,
    ipToBigInt,
    isTrustedProxy,
    normaliseIp,
    parseCidr,
    resolveTrustedClientIpOptions,
    trustedClientIpMiddleware,
} from './client-ip';
export type { ClientIpResolveOptions, ClientIpSource, ResolvedTrustedClientIpOptions, TrustedClientIpOptions } from './client-ip';
export {
    DEFAULT_MUTATION_RATE_LIMITS,
    createMutationRateLimitHandler,
    countMutationCalls,
    countRequestMutationCalls,
    extractMutationNames,
    persistedQueryNotFoundBody,
    rateLimitedBody,
    resolveMutationRateLimits,
    shopApiMutationRateLimitMiddleware,
} from './mutation-rate-limit';
export type {
    MutationRateLimit,
    MutationRateLimitHandlerOptions,
    MutationRateLimitOverrides,
    MutationRateLimits,
} from './mutation-rate-limit';
