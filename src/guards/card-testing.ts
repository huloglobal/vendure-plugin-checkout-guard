/**
 * Card-testing gate.
 *
 * Carders run stolen card numbers through the cheapest product in a
 * storefront: one cart, a new card every few seconds, until one works.
 * Stripe Radar declines most of them, but every attempt still creates a
 * PaymentIntent, costs an authorisation, and — because the attempts share
 * the per-IP token buckets with real shoppers behind the same proxy — can
 * starve genuine checkouts.
 *
 * This gate closes the loop that the plugin's own records make possible:
 * `checkout_guard_payment_event` already stores every failed and
 * client-declined attempt with the client IP and order code. Once an IP
 * has `maxFailedPerIp` failures inside `windowMinutes` the payment
 * mutations (`createStripePaymentIntent`, `addPaymentToOrder`) answer 429
 * for `blockMinutes`; once an order has `maxFailedPerOrder` failures the
 * host's `paymentIntentCreateParams` hook (via
 * `CheckoutGuardService.cardTestingVerdict`) refuses to mint another
 * intent for it.
 *
 * Like the rest of the guards module this file never imports the plugin
 * or a Nest service: the plugin installs the failure lookup at bootstrap
 * (`setFailureLookup`). Until then the gate is a no-op. FREE tier.
 */
import { bumpCounter } from './counters';

export interface CardTestingOptions {
    /** Failed + client-declined attempts from one IP inside the window before its payment mutations are refused. Default 4. `0` disables the IP gate. */
    maxFailedPerIp?: number;
    /** Failed attempts on one order before no further PaymentIntent is created for it. Default 3. `0` disables the order gate. */
    maxFailedPerOrder?: number;
    /** Look-back for both counts, in minutes. Default 60. */
    windowMinutes?: number;
    /** How long a tripped IP stays refused, in minutes. Default 720 (12 h). */
    blockMinutes?: number;
    /** Shop API mutations the IP gate covers. Default `createStripePaymentIntent` and `addPaymentToOrder`. */
    mutations?: string[];
}

export interface ResolvedCardTestingOptions {
    maxFailedPerIp: number;
    maxFailedPerOrder: number;
    windowMinutes: number;
    blockMinutes: number;
    mutations: string[];
}

export const DEFAULT_CARD_TESTING: ResolvedCardTestingOptions = {
    maxFailedPerIp: 4,
    maxFailedPerOrder: 3,
    windowMinutes: 60,
    blockMinutes: 720,
    mutations: ['createStripePaymentIntent', 'addPaymentToOrder'],
};

export function resolveCardTestingOptions(opts?: CardTestingOptions | false | null): ResolvedCardTestingOptions | null {
    if (opts === false || opts === null) return null;
    const o = opts || {};
    const num = (v: unknown, d: number, min = 0) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= min ? Math.floor(n) : d;
    };
    const mutations = (Array.isArray(o.mutations) ? o.mutations : DEFAULT_CARD_TESTING.mutations)
        .map(m => String(m).trim()).filter(m => /^[A-Za-z_][A-Za-z0-9_]*$/.test(m));
    return {
        maxFailedPerIp: num(o.maxFailedPerIp, DEFAULT_CARD_TESTING.maxFailedPerIp),
        maxFailedPerOrder: num(o.maxFailedPerOrder, DEFAULT_CARD_TESTING.maxFailedPerOrder),
        windowMinutes: num(o.windowMinutes, DEFAULT_CARD_TESTING.windowMinutes, 1),
        blockMinutes: num(o.blockMinutes, DEFAULT_CARD_TESTING.blockMinutes, 1),
        mutations: mutations.length ? mutations : [...DEFAULT_CARD_TESTING.mutations],
    };
}

/** Counts failed + client-declined attempts from `ip` in the last `windowMinutes` (only those after `since`, when given: an admin unblock). */
export type FailureLookup = (ip: string, windowMinutes: number, since?: Date) => Promise<number>;

/** One block in force, as the admin blocked list shows it. */
export interface CardTestingBlock {
    ip: string;
    failures: number;
    blockedAt: Date;
    blockedUntil: Date;
    surface: string;
}

/**
 * Shared block list (the plugin's `cg_ip_block` table). Lets every server
 * process see the same blocks and unblocks, and keeps them across restarts.
 * Optional: without one the gate keeps its blocks in this process only.
 */
export interface CardTestingBlockStore {
    save(block: CardTestingBlock): Promise<void>;
    /** Blocks in force and unblock times (ip → when an admin lifted it). */
    load(): Promise<{ blocks: CardTestingBlock[]; cleared: Map<string, Date> }>;
}

export interface CardTestingBlockInfo {
    ip: string;
    failures: number;
    blockedUntil: Date;
    mutation: string;
}

export type CardTestingBlockListener = (info: CardTestingBlockInfo) => void;

let lookup: FailureLookup | null = null;
let listener: CardTestingBlockListener | null = null;
let blockStore: CardTestingBlockStore | null = null;

let shareBlocks: () => boolean = () => true;

/**
 * Install (or remove) the shared block list. `share` says whether blocks other
 * processes (or an earlier run) stored are enforced here: the plugin ties it to a
 * shared limiter store, so with the default `memory` store a restart still clears
 * blocks as in 0.3 while the admin list and unblocks keep working.
 */
export function setCardTestingBlockStore(store: CardTestingBlockStore | null, share?: () => boolean): void {
    blockStore = store;
    shareBlocks = share ?? (() => true);
}

/** Install (or remove with `null`) the failure lookup. The plugin wires `ObservabilityService.countRecentFailures`. */
export function setFailureLookup(fn: FailureLookup | null): void {
    lookup = fn;
}

/** Called once per IP per block window when the gate trips (ops alert). */
export function setCardTestingBlockListener(fn: CardTestingBlockListener | null): void {
    listener = fn;
}

/** Body of the 429 the gate answers with. Distinct from the token-bucket `rate_limited` so storefronts can word it. */
export function cardTestingBlockedBody(mutation: string): { errors: Array<{ message: string; extensions: { code: string; mutation: string; reason: string } }> } {
    return { errors: [{ message: 'card_testing_blocked', extensions: { code: 'RATE_LIMITED', mutation, reason: 'card_testing' } }] };
}

const NEGATIVE_CACHE_MS = 30_000;
const STORE_SYNC_MS = 30_000;
const MAX_TRACKED = 10_000;

/**
 * Per-IP gate with two small caches so a hot checkout path costs at most
 * one COUNT per IP per 30 s, and nothing at all once an IP is blocked.
 */
export class CardTestingGate {
    private readonly blocked = new Map<string, number>();            // ip → blockedUntil (ms)
    private readonly blockInfo = new Map<string, { at: number; failures: number; surface: string }>();
    private readonly recent = new Map<string, { n: number; at: number }>();
    /** ip → when an admin lifted its block: failures before then no longer count. */
    private readonly cleared = new Map<string, number>();
    private lastSync = 0;
    private syncing: Promise<void> | null = null;

    constructor(public opts: ResolvedCardTestingOptions, private readonly now: () => number = () => Date.now()) {}

    /** Apply new limits (admin settings) without forgetting blocks in force. */
    setOptions(opts: ResolvedCardTestingOptions): void {
        if (JSON.stringify(opts) === JSON.stringify(this.opts)) return;
        this.opts = opts;
        this.recent.clear();
    }

    covers(mutation: string): boolean {
        return this.opts.maxFailedPerIp > 0 && this.opts.mutations.includes(mutation);
    }

    /** False until the plugin installs the failure lookup (and nothing is blocked): the middleware then skips the async path entirely. */
    isActive(): boolean {
        return !!lookup || this.blocked.size > 0;
    }

    /** `blocked: true` when the IP must not create another payment attempt. Never throws. */
    async check(ip: string | null, mutation: string): Promise<{ blocked: boolean; failures: number; blockedUntil?: Date }> {
        if (!ip || !this.covers(mutation)) return { blocked: false, failures: 0 };
        await this.syncFromStore();
        const t = this.now();
        const until = this.blocked.get(ip);
        if (until !== undefined) {
            if (until > t) return { blocked: true, failures: this.recent.get(ip)?.n ?? this.opts.maxFailedPerIp, blockedUntil: new Date(until) };
            this.blocked.delete(ip);
        }
        if (!lookup) return { blocked: false, failures: 0 };
        const cached = this.recent.get(ip);
        let n: number;
        if (cached && t - cached.at < NEGATIVE_CACHE_MS) {
            n = cached.n;
        } else {
            const since = this.cleared.get(ip);
            try { n = Math.max(0, Math.floor(Number(await lookup(ip, this.opts.windowMinutes, since ? new Date(since) : undefined)) || 0)); } catch { n = cached?.n ?? 0; }
            this.remember(this.recent, ip, { n, at: t });
        }
        if (n >= this.opts.maxFailedPerIp) {
            const blockedUntil = t + this.opts.blockMinutes * 60_000;
            this.remember(this.blocked, ip, blockedUntil);
            this.remember(this.blockInfo, ip, { at: t, failures: n, surface: mutation });
            if (blockStore) {
                const store = blockStore;
                void store.save({ ip, failures: n, blockedAt: new Date(t), blockedUntil: new Date(blockedUntil), surface: mutation }).catch(() => undefined);
            }
            bumpCounter('card_testing_block');
            try { listener?.({ ip, failures: n, blockedUntil: new Date(blockedUntil), mutation }); } catch { /* alerting never affects a request */ }
            return { blocked: true, failures: n, blockedUntil: new Date(blockedUntil) };
        }
        return { blocked: false, failures: n };
    }

    /** Lift a block early (admin action / tests): failures before now no longer count for this IP. */
    unblock(ip: string): void {
        this.blocked.delete(ip);
        this.blockInfo.delete(ip);
        this.recent.delete(ip);
        this.remember(this.cleared, ip, this.now());
    }

    /** Blocks in force in this process (merged with the shared store on the next sync). */
    list(): CardTestingBlock[] {
        const t = this.now();
        const out: CardTestingBlock[] = [];
        for (const [ip, until] of this.blocked) {
            if (until <= t) continue;
            const info = this.blockInfo.get(ip);
            out.push({ ip, failures: info?.failures ?? this.opts.maxFailedPerIp, blockedAt: new Date(info?.at ?? t), blockedUntil: new Date(until), surface: info?.surface ?? '' });
        }
        return out;
    }

    /** Pull blocks and unblocks other processes wrote (at most every 30 s). Never throws. */
    async syncFromStore(force = false): Promise<void> {
        if (!blockStore) return;
        const t = this.now();
        if (!force && t - this.lastSync < STORE_SYNC_MS) return;
        if (this.syncing) return this.syncing;
        this.lastSync = t;
        const store = blockStore;
        this.syncing = (async () => {
            try {
                const { blocks, cleared } = await store.load();
                for (const [ip, at] of cleared) {
                    const ms = at.getTime();
                    if ((this.cleared.get(ip) ?? 0) >= ms) continue;
                    this.remember(this.cleared, ip, ms);
                    const info = this.blockInfo.get(ip);
                    if (!info || info.at <= ms) { this.blocked.delete(ip); this.blockInfo.delete(ip); this.recent.delete(ip); }
                }
                let share = true;
                try { share = shareBlocks(); } catch { share = false; }
                for (const b of share ? blocks : []) {
                    const until = b.blockedUntil.getTime();
                    if (until <= t || (this.cleared.get(b.ip) ?? 0) >= b.blockedAt.getTime()) continue;
                    if ((this.blocked.get(b.ip) ?? 0) >= until) continue;
                    this.remember(this.blocked, b.ip, until);
                    this.remember(this.blockInfo, b.ip, { at: b.blockedAt.getTime(), failures: b.failures, surface: b.surface });
                }
            } catch { /* the gate keeps working on its own state */ }
        })().finally(() => { this.syncing = null; });
        return this.syncing;
    }

    private remember<V>(map: Map<string, V>, key: string, value: V): void {
        if (map.size >= MAX_TRACKED && !map.has(key)) {
            const oldest = map.keys().next().value;
            if (oldest !== undefined) map.delete(oldest);
        }
        map.delete(key);
        map.set(key, value);
    }
}

/** Test hook. */
export function _resetCardTestingHooks(): void {
    lookup = null;
    listener = null;
    blockStore = null;
    shareBlocks = () => true;
}
