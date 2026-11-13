/**
 * Admin-editable settings (Settings tab), merged over the `init()` options.
 *
 * The plugin options in `vendure-config.ts` stay the defaults: a field the
 * admin never saved keeps the code's value, and "Reset to code defaults"
 * deletes the saved object. Secrets (webhook secrets, the trusted-proxy
 * secret, ops channel URLs) and anything Vendure needs at boot (custom
 * fields, payment handlers) are NOT editable here. A host can switch the
 * whole tab to read-only with `adminSettings: false`.
 *
 * Pure: validation and merging only, no I/O, so every rule is unit-tested.
 */
import type { MutationRateLimitOverrides } from '../guards/mutation-rate-limit';
import type { CardTestingOptions } from '../guards/card-testing';
import type { LimiterStoreKind } from '../guards/limiter-store';
import { LIMITER_STORE_KINDS } from '../guards/limiter-store';

export interface LoginGuardOptions {
    /** Off by default. On: failed `login` / `authenticate` attempts are counted per client IP. */
    enabled?: boolean;
    /** Failed attempts inside the window before further logins from that IP are refused. Default 5. */
    maxFailures?: number;
    /** Counting window and lockout length, in minutes. Default 15. */
    windowMinutes?: number;
    /** Which APIs: `both` (default), `admin` or `shop`. */
    apis?: 'both' | 'admin' | 'shop';
}

export interface OrderLookupLimitOptions {
    /** Off by default. On: Shop API `orderByCode` queries are limited per client IP. */
    enabled?: boolean;
    /** Lookups allowed per window. Default 20. */
    capacity?: number;
    /** Window in seconds. Default 60. */
    windowSeconds?: number;
}

export interface HoldSourcesOptions {
    /** Premium, off by default: list manual-capture HULO Payments payments (handlers `hulo-*`) with the Stripe holds, with capture and release. */
    huloPayments?: boolean;
    /** Premium, off by default: the hourly safety capture also captures HULO Payments holds past `safetyCaptureDays`. */
    huloPaymentsSafetyCapture?: boolean;
}

/** What an admin may change. Every field optional: absent means "use the code's value". */
export interface AdminSettings {
    rateLimits?: { store?: LimiterStoreKind; mutations?: Record<string, { capacity: number; windowMs: number } | false> };
    cardTesting?: { enabled?: boolean; maxFailedPerIp?: number; maxFailedPerOrder?: number; windowMinutes?: number; blockMinutes?: number; autoOrderGate?: boolean };
    loginGuard?: LoginGuardOptions;
    orderLookup?: OrderLookupLimitOptions;
    bankTransfer?: { expiryDays?: number; reminderAfterDays?: number; emails?: boolean };
    stripe?: { safetyCaptureDays?: number; autoCaptureBelowMinor?: number | null };
    reconciliation?: { enabled?: boolean; lookbackDays?: number; amountDrift?: boolean };
    holds?: HoldSourcesOptions;
}

/** The slice of `CheckoutGuardPluginOptions` the settings touch (kept structural to avoid an import cycle). */
export interface MergeableOptions {
    rateLimits?: { mutations?: MutationRateLimitOverrides; store?: LimiterStoreKind };
    cardTesting?: (CardTestingOptions & { autoOrderGate?: boolean }) | false;
    loginGuard?: LoginGuardOptions;
    orderLookup?: OrderLookupLimitOptions;
    bankTransfer?: { expiryDays?: number; reminderAfterDays?: number; emails?: boolean | { enabled?: boolean }; [k: string]: unknown };
    stripe?: { safetyCaptureDays?: number; autoCaptureBelowMinor?: number; [k: string]: unknown };
    reconciliation?: { enabled?: boolean; lookbackDays?: number; amountDrift?: boolean };
    holds?: HoldSourcesOptions;
    [k: string]: unknown;
}

const MUTATION_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function int(v: unknown, min: number, max: number): number | undefined {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Not a number: ${String(v).slice(0, 20)}`);
    const i = Math.floor(n);
    if (i < min || i > max) throw new Error(`${i} is outside ${min}–${max}`);
    return i;
}

function bool(v: unknown): boolean | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'boolean') return v;
    throw new Error('Expected true or false');
}

function prune<T extends Record<string, unknown>>(o: T): T | undefined {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
    return Object.keys(out).length ? out as T : undefined;
}

function field<T>(label: string, fn: () => T): T {
    try { return fn(); } catch (e: any) { throw new Error(`${label}: ${e?.message || e}`); }
}

/**
 * Validate a settings object from the admin UI. Throws `Error` with a
 * field-named message on the first bad value; unknown keys are dropped.
 */
export function sanitiseAdminSettings(input: unknown): AdminSettings {
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
    const out: AdminSettings = {};

    if (i.rateLimits && typeof i.rateLimits === 'object') {
        const store = i.rateLimits.store;
        if (store !== undefined && store !== null && !LIMITER_STORE_KINDS.includes(store)) throw new Error('rateLimits.store: use memory, database or cache');
        let mutations: Record<string, { capacity: number; windowMs: number } | false> | undefined;
        if (i.rateLimits.mutations && typeof i.rateLimits.mutations === 'object') {
            mutations = {};
            const entries = Object.entries(i.rateLimits.mutations as Record<string, any>);
            if (entries.length > 30) throw new Error('rateLimits.mutations: at most 30 entries');
            for (const [name, v] of entries) {
                if (!MUTATION_NAME.test(name)) throw new Error(`rateLimits.mutations: "${name.slice(0, 40)}" is not a GraphQL field name`);
                if (v === false) { mutations[name] = false; continue; }
                mutations[name] = {
                    capacity: field(`rateLimits.mutations.${name}.capacity`, () => int(v?.capacity, 1, 10_000))!,
                    windowMs: field(`rateLimits.mutations.${name}.windowMs`, () => int(v?.windowMs, 1_000, 86_400_000))!,
                };
                if (mutations[name] && ((mutations[name] as any).capacity === undefined || (mutations[name] as any).windowMs === undefined)) {
                    throw new Error(`rateLimits.mutations.${name}: capacity and windowMs are both required`);
                }
            }
        }
        out.rateLimits = prune({ store: store ?? undefined, mutations });
    }
    if (i.cardTesting && typeof i.cardTesting === 'object') {
        const c = i.cardTesting;
        out.cardTesting = prune({
            enabled: field('cardTesting.enabled', () => bool(c.enabled)),
            maxFailedPerIp: field('cardTesting.maxFailedPerIp', () => int(c.maxFailedPerIp, 0, 1000)),
            maxFailedPerOrder: field('cardTesting.maxFailedPerOrder', () => int(c.maxFailedPerOrder, 0, 1000)),
            windowMinutes: field('cardTesting.windowMinutes', () => int(c.windowMinutes, 1, 10_080)),
            blockMinutes: field('cardTesting.blockMinutes', () => int(c.blockMinutes, 1, 43_200)),
            autoOrderGate: field('cardTesting.autoOrderGate', () => bool(c.autoOrderGate)),
        });
    }
    if (i.loginGuard && typeof i.loginGuard === 'object') {
        const l = i.loginGuard;
        if (l.apis !== undefined && l.apis !== null && !['both', 'admin', 'shop'].includes(l.apis)) throw new Error('loginGuard.apis: use both, admin or shop');
        out.loginGuard = prune({
            enabled: field('loginGuard.enabled', () => bool(l.enabled)),
            maxFailures: field('loginGuard.maxFailures', () => int(l.maxFailures, 1, 1000)),
            windowMinutes: field('loginGuard.windowMinutes', () => int(l.windowMinutes, 1, 1440)),
            apis: l.apis ?? undefined,
        });
    }
    if (i.orderLookup && typeof i.orderLookup === 'object') {
        const o = i.orderLookup;
        out.orderLookup = prune({
            enabled: field('orderLookup.enabled', () => bool(o.enabled)),
            capacity: field('orderLookup.capacity', () => int(o.capacity, 1, 10_000)),
            windowSeconds: field('orderLookup.windowSeconds', () => int(o.windowSeconds, 1, 86_400)),
        });
    }
    if (i.bankTransfer && typeof i.bankTransfer === 'object') {
        const b = i.bankTransfer;
        out.bankTransfer = prune({
            expiryDays: field('bankTransfer.expiryDays', () => int(b.expiryDays, 1, 90)),
            reminderAfterDays: field('bankTransfer.reminderAfterDays', () => int(b.reminderAfterDays, 1, 89)),
            emails: field('bankTransfer.emails', () => bool(b.emails)),
        });
        if (out.bankTransfer?.expiryDays !== undefined && out.bankTransfer?.reminderAfterDays !== undefined
            && out.bankTransfer.reminderAfterDays >= out.bankTransfer.expiryDays) {
            throw new Error('bankTransfer.reminderAfterDays must be fewer than expiryDays');
        }
    }
    if (i.stripe && typeof i.stripe === 'object') {
        const s = i.stripe;
        const auto = s.autoCaptureBelowMinor === null ? null : field('stripe.autoCaptureBelowMinor', () => int(s.autoCaptureBelowMinor, 1, 1_000_000_000));
        out.stripe = prune({
            safetyCaptureDays: field('stripe.safetyCaptureDays', () => int(s.safetyCaptureDays, 1, 7)),
            autoCaptureBelowMinor: auto,
        });
    }
    if (i.reconciliation && typeof i.reconciliation === 'object') {
        const r = i.reconciliation;
        out.reconciliation = prune({
            enabled: field('reconciliation.enabled', () => bool(r.enabled)),
            lookbackDays: field('reconciliation.lookbackDays', () => int(r.lookbackDays, 1, 30)),
            amountDrift: field('reconciliation.amountDrift', () => bool(r.amountDrift)),
        });
    }
    if (i.holds && typeof i.holds === 'object') {
        out.holds = prune({
            huloPayments: field('holds.huloPayments', () => bool(i.holds.huloPayments)),
            huloPaymentsSafetyCapture: field('holds.huloPaymentsSafetyCapture', () => bool(i.holds.huloPaymentsSafetyCapture)),
        });
    }
    for (const k of Object.keys(out) as Array<keyof AdminSettings>) if (out[k] === undefined) delete out[k];
    return out;
}

/** `bankTransfer.emails` may be `true` or `{ enabled: true }` in init options. */
export function bankEmailsEnabled(v: unknown): boolean {
    if (typeof v === 'boolean') return v;
    return !!(v && typeof v === 'object' && (v as { enabled?: unknown }).enabled === true);
}

/**
 * Effective options: the init options with the admin's saved values on top.
 * Returns a new object; the inputs are not modified.
 */
export function mergeAdminSettings<T extends MergeableOptions>(base: T, s: AdminSettings | null | undefined): T {
    if (!s || !Object.keys(s).length) return base;
    const out: any = { ...base };
    if (s.rateLimits) {
        const mutations = s.rateLimits.mutations
            ? { ...(base.rateLimits?.mutations || {}), ...s.rateLimits.mutations }
            : base.rateLimits?.mutations;
        out.rateLimits = { ...(base.rateLimits || {}), mutations, ...(s.rateLimits.store ? { store: s.rateLimits.store } : {}) };
    }
    if (s.cardTesting) {
        const { enabled, ...rest } = s.cardTesting;
        if (enabled === false) out.cardTesting = false;
        else {
            const from = base.cardTesting === false ? {} : (base.cardTesting || {});
            if (enabled === true || base.cardTesting !== false) out.cardTesting = { ...from, ...rest };
        }
    }
    if (s.loginGuard) out.loginGuard = { ...(base.loginGuard || {}), ...s.loginGuard };
    if (s.orderLookup) out.orderLookup = { ...(base.orderLookup || {}), ...s.orderLookup };
    if (s.bankTransfer) out.bankTransfer = { ...(base.bankTransfer || {}), ...s.bankTransfer };
    if (s.stripe) {
        const stripe: any = { ...(base.stripe || {}) };
        if (s.stripe.safetyCaptureDays !== undefined) stripe.safetyCaptureDays = s.stripe.safetyCaptureDays;
        if (s.stripe.autoCaptureBelowMinor === null) delete stripe.autoCaptureBelowMinor;
        else if (s.stripe.autoCaptureBelowMinor !== undefined) stripe.autoCaptureBelowMinor = s.stripe.autoCaptureBelowMinor;
        out.stripe = stripe;
    }
    if (s.reconciliation) out.reconciliation = { ...(base.reconciliation || {}), ...s.reconciliation };
    if (s.holds) out.holds = { ...(base.holds || {}), ...s.holds };
    return out as T;
}

export const LOGIN_GUARD_DEFAULTS = Object.freeze({ maxFailures: 5, windowMinutes: 15, apis: 'both' as const });
export const ORDER_LOOKUP_DEFAULTS = Object.freeze({ capacity: 20, windowSeconds: 60 });

export function resolveLoginGuard(o?: LoginGuardOptions | null): { maxFailures: number; windowMs: number; apis: 'both' | 'admin' | 'shop' } | null {
    if (!o || o.enabled !== true) return null;
    const max = Number(o.maxFailures);
    const win = Number(o.windowMinutes);
    return {
        maxFailures: Number.isFinite(max) && max >= 1 ? Math.floor(max) : LOGIN_GUARD_DEFAULTS.maxFailures,
        windowMs: (Number.isFinite(win) && win >= 1 ? Math.floor(win) : LOGIN_GUARD_DEFAULTS.windowMinutes) * 60_000,
        apis: o.apis === 'admin' || o.apis === 'shop' ? o.apis : 'both',
    };
}

export function resolveOrderLookup(o?: OrderLookupLimitOptions | null): { capacity: number; windowMs: number } | null {
    if (!o || o.enabled !== true) return null;
    const cap = Number(o.capacity);
    const win = Number(o.windowSeconds);
    return {
        capacity: Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : ORDER_LOOKUP_DEFAULTS.capacity,
        windowMs: (Number.isFinite(win) && win >= 1 ? Math.floor(win) : ORDER_LOOKUP_DEFAULTS.windowSeconds) * 1000,
    };
}
