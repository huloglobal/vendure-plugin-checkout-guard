import { createHash } from 'crypto';
import { Logger } from '@vendure/core';
import type { DbAdapter } from '@huloglobal/vendure-licence-sdk';
import { GUARDS_LOGGER_CTX } from './constants';

/**
 * Where the rate-limit counters live.
 *
 *   • `memory`   (default, the 0.3.x behaviour): per process. Every Vendure
 *                server process counts on its own, and a restart forgets.
 *   • `database` shared by every process: one atomic upsert per limited
 *                request in `cg_rate` (fixed windows), so a limit means the
 *                same thing behind a load balancer and across restarts.
 *   • `cache`    Vendure's `CacheService` (Redis when the host configured a
 *                Redis cache strategy, otherwise Vendure's default). Counts
 *                are read-modify-write, so two processes racing can both
 *                count one; good enough for abuse limits, cheaper than SQL.
 *
 * A shared backend that fails (table missing, Redis down) never blocks a
 * request: that call falls back to the in-memory counter and the failure is
 * logged once a minute.
 */
export type LimiterStoreKind = 'memory' | 'database' | 'cache';

export const LIMITER_STORE_KINDS: readonly LimiterStoreKind[] = ['memory', 'database', 'cache'];

export const RATE_TABLE = 'cg_rate';

export interface FixedWindowResult {
    /** Hits in the current window, this one included. */
    count: number;
    /** Seconds until the window ends. */
    retryAfterSec: number;
    /** Which backend answered (a failed shared store answers `memory`). */
    store: LimiterStoreKind;
}

export interface LimiterBackend {
    readonly kind: LimiterStoreKind;
    /** Add `by` hits to `bucket` (expires at `expiresAtMs`) and return the new count. */
    incr(bucket: string, by: number, expiresAtMs: number): Promise<number>;
    /** Current count without adding a hit. */
    peek(bucket: string): Promise<number>;
    /** Drop a bucket (admin unblock). */
    reset(bucket: string): Promise<void>;
}

/** Minimal shape of Vendure's CacheService (3.1+); typed loosely so 3.5–3.x all fit. */
export interface CacheLike {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set<T = unknown>(key: string, value: T, options?: { ttl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
}

const MAX_MEMORY_BUCKETS = 50_000;

export class MemoryLimiterBackend implements LimiterBackend {
    readonly kind = 'memory' as const;
    private readonly buckets = new Map<string, { n: number; exp: number }>();
    constructor(private readonly now: () => number = () => Date.now()) {}

    async incr(bucket: string, by: number, expiresAtMs: number): Promise<number> {
        return this.incrSync(bucket, by, expiresAtMs);
    }

    incrSync(bucket: string, by: number, expiresAtMs: number, t: number = this.now()): number {
        let row = this.buckets.get(bucket);
        if (!row || row.exp <= t) row = { n: 0, exp: expiresAtMs };
        row.n += by;
        this.buckets.delete(bucket);
        this.buckets.set(bucket, row);
        if (this.buckets.size > MAX_MEMORY_BUCKETS) this.evict(t);
        return row.n;
    }

    async peek(bucket: string, t: number = this.now()): Promise<number> {
        const row = this.buckets.get(bucket);
        return row && row.exp > t ? row.n : 0;
    }

    async reset(bucket: string): Promise<void> {
        this.buckets.delete(bucket);
    }

    private evict(t: number): void {
        for (const [k, v] of this.buckets) if (v.exp <= t) this.buckets.delete(k);
        while (this.buckets.size > MAX_MEMORY_BUCKETS) {
            const oldest = this.buckets.keys().next().value;
            if (oldest === undefined) break;
            this.buckets.delete(oldest);
        }
    }
}

export class DatabaseLimiterBackend implements LimiterBackend {
    readonly kind = 'database' as const;
    private lastPrune = 0;
    constructor(private readonly db: () => DbAdapter, private readonly now: () => number = () => Date.now()) {}

    async incr(bucket: string, by: number, expiresAtMs: number): Promise<number> {
        const db = this.db();
        await db.query(
            `INSERT INTO ${RATE_TABLE} (bucket, n, expires) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE n = ${RATE_TABLE}.n + VALUES(n)`,
            [bucket, by, Math.ceil(expiresAtMs / 1000)],
            { conflictColumns: ['bucket'] },
        );
        const rows = await db.query(`SELECT n FROM ${RATE_TABLE} WHERE bucket = ?`, [bucket]);
        this.maybePrune();
        return Math.max(by, Number(rows?.[0]?.n || by));
    }

    async peek(bucket: string): Promise<number> {
        const rows = await this.db().query(`SELECT n, expires FROM ${RATE_TABLE} WHERE bucket = ?`, [bucket]);
        const r = rows?.[0];
        if (!r || Number(r.expires) * 1000 <= this.now()) return 0;
        return Number(r.n || 0);
    }

    async reset(bucket: string): Promise<void> {
        await this.db().query(`DELETE FROM ${RATE_TABLE} WHERE bucket = ?`, [bucket]);
    }

    /** Expired windows are dropped at most once a minute, off the request path. */
    private maybePrune(): void {
        const t = this.now();
        if (t - this.lastPrune < 60_000) return;
        this.lastPrune = t;
        void this.db().query(`DELETE FROM ${RATE_TABLE} WHERE expires < ?`, [Math.floor(t / 1000) - 60]).catch(() => undefined);
    }
}

export class CacheLimiterBackend implements LimiterBackend {
    readonly kind = 'cache' as const;
    constructor(private readonly cache: CacheLike, private readonly now: () => number = () => Date.now()) {}

    async incr(bucket: string, by: number, expiresAtMs: number): Promise<number> {
        const key = `cg-rate:${bucket}`;
        const cur = Number((await this.cache.get<number>(key)) || 0);
        const n = cur + by;
        await this.cache.set(key, n, { ttl: Math.max(1000, expiresAtMs - this.now()) });
        return n;
    }

    async peek(bucket: string): Promise<number> {
        return Number((await this.cache.get<number>(`cg-rate:${bucket}`)) || 0);
    }

    async reset(bucket: string): Promise<void> {
        await this.cache.delete(`cg-rate:${bucket}`);
    }
}

/** DDL for the shared counters (through the SDK dialect adapter; Postgres-safe). */
export async function ensureRateTable(db: DbAdapter): Promise<void> {
    await db.query(`
        CREATE TABLE IF NOT EXISTS ${RATE_TABLE} (
            bucket VARCHAR(64) NOT NULL PRIMARY KEY,
            n INT NOT NULL DEFAULT 0,
            expires BIGINT NOT NULL,
            INDEX idx_cg_rate_expires (expires)
        )
    `);
}

// ── Process-wide backend selection ───────────────────────────────────

const memory = new MemoryLimiterBackend();
let shared: { database?: LimiterBackend; cache?: LimiterBackend } = {};
let selected: () => LimiterStoreKind = () => 'memory';
let lastFailureLog = 0;

/** Installed by the plugin at bootstrap. */
export function setLimiterBackends(backends: { database?: LimiterBackend; cache?: LimiterBackend }, kind: () => LimiterStoreKind): void {
    shared = { ...backends };
    selected = kind;
}

/** The store the settings ask for, if it is available. */
export function currentLimiterStore(): LimiterStoreKind {
    let k: LimiterStoreKind = 'memory';
    try { k = selected(); } catch { k = 'memory'; }
    if (k === 'database' && shared.database) return 'database';
    if (k === 'cache' && shared.cache) return 'cache';
    return 'memory';
}

export function memoryLimiter(): MemoryLimiterBackend {
    return memory;
}

/** sha1 bucket id for (rule, key, window length, window index): fits VARCHAR(64), carries no raw IP. */
export function windowBucket(rule: string, key: string, windowMs: number, index: number): string {
    return createHash('sha1').update(`${rule}|${key}|${windowMs}|${index}`).digest('hex');
}

function windowOf(windowMs: number, t: number): { index: number; endMs: number } {
    const w = Math.max(1000, Math.floor(windowMs));
    const index = Math.floor(t / w);
    return { index, endMs: (index + 1) * w };
}

/**
 * Count `by` hits for (rule, key) in the current fixed window of `windowMs`
 * on the selected store. Never throws: a failing shared store is answered
 * from memory.
 */
export async function hitFixedWindow(rule: string, key: string, windowMs: number, by: number = 1, now: number = Date.now()): Promise<FixedWindowResult> {
    const { index, endMs } = windowOf(windowMs, now);
    const bucket = windowBucket(rule, key, Math.floor(windowMs), index);
    const retryAfterSec = Math.max(1, Math.ceil((endMs - now) / 1000));
    const kind = currentLimiterStore();
    if (kind !== 'memory') {
        try {
            const n = await shared[kind]!.incr(bucket, by, endMs);
            return { count: n, retryAfterSec, store: kind };
        } catch (e: any) {
            logFailure(kind, e);
        }
    }
    return { count: memory.incrSync(bucket, by, endMs, now), retryAfterSec, store: 'memory' };
}

/** Hits so far in the current window, without adding one. Never throws. */
export async function peekFixedWindow(rule: string, key: string, windowMs: number, now: number = Date.now()): Promise<number> {
    const { index } = windowOf(windowMs, now);
    const bucket = windowBucket(rule, key, Math.floor(windowMs), index);
    const kind = currentLimiterStore();
    if (kind !== 'memory') {
        try { return await shared[kind]!.peek(bucket); } catch (e: any) { logFailure(kind, e); }
    }
    return memory.peek(bucket, now);
}

/** Forget (rule, key)'s current window everywhere (admin unblock). Never throws. */
export async function resetFixedWindow(rule: string, key: string, windowMs: number, now: number = Date.now()): Promise<void> {
    const { index } = windowOf(windowMs, now);
    const bucket = windowBucket(rule, key, Math.floor(windowMs), index);
    await memory.reset(bucket);
    for (const b of [shared.database, shared.cache]) {
        if (b) await b.reset(bucket).catch(() => undefined);
    }
}

function logFailure(kind: LimiterStoreKind, e: any): void {
    const t = Date.now();
    if (t - lastFailureLog < 60_000) return;
    lastFailureLog = t;
    Logger.warn(`Rate-limit store "${kind}" failed (${e?.message || e}); counting in memory for now`, GUARDS_LOGGER_CTX);
}

/** Test hook. */
export function _resetLimiterBackends(): void {
    shared = {};
    selected = () => 'memory';
}
