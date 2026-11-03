import { createHash } from 'crypto';
import { RateLimiter } from '@huloglobal/vendure-licence-sdk';
import { Logger } from '@vendure/core';
import type { Middleware } from '@vendure/core';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ClientIpResolveOptions, getClientIp } from './client-ip';
import { GUARDS_LOGGER_CTX } from './constants';
import { bumpCounter } from './counters';
import { CardTestingGate, CardTestingOptions, cardTestingBlockedBody, resolveCardTestingOptions } from './card-testing';

export interface MutationRateLimit {
    /** Requests allowed per window (token-bucket capacity). */
    capacity: number;
    /** Window length in milliseconds. */
    windowMs: number;
}

export type MutationRateLimits = Record<string, MutationRateLimit>;

/** Per-override value: partial limit, or `false` / `capacity: 0` to disable that mutation's limit. */
export type MutationRateLimitOverrides = Record<string, Partial<MutationRateLimit> | false | null | undefined>;

const MINUTE = 60_000;

export const DEFAULT_MUTATION_RATE_LIMITS: MutationRateLimits = {
    applyCouponCode: { capacity: 10, windowMs: MINUTE },
    addPaymentToOrder: { capacity: 6, windowMs: MINUTE },
    createStripePaymentIntent: { capacity: 6, windowMs: MINUTE },
    transitionOrderToState: { capacity: 20, windowMs: MINUTE },
};

/** Merges host overrides onto the defaults; unknown mutation names are added, disabled ones removed. */
export function resolveMutationRateLimits(overrides?: MutationRateLimitOverrides): MutationRateLimits {
    const result: MutationRateLimits = {};
    for (const [name, limit] of Object.entries(DEFAULT_MUTATION_RATE_LIMITS)) {
        result[name] = { ...limit };
    }
    for (const [rawName, override] of Object.entries(overrides || {})) {
        const name = rawName.trim();
        if (!name) continue;
        if (override === false || override === null || override === undefined) {
            delete result[name];
            continue;
        }
        const base = result[name] || { capacity: 0, windowMs: MINUTE };
        const merged: MutationRateLimit = {
            capacity: override.capacity !== undefined ? Number(override.capacity) : base.capacity,
            windowMs: override.windowMs !== undefined ? Number(override.windowMs) : base.windowMs,
        };
        if (!Number.isFinite(merged.capacity) || merged.capacity <= 0 || !Number.isFinite(merged.windowMs) || merged.windowMs <= 0) {
            delete result[name];
            continue;
        }
        result[name] = merged;
    }
    return result;
}

const MUTATION_KEYWORD = /\bmutation\b/;
const patternCache = new Map<string, RegExp>();

function patternFor(name: string): RegExp {
    let pattern = patternCache.get(name);
    if (!pattern) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Field selection (optionally aliased), with or without arguments:
        // `applyCouponCode(` / `apply: applyCouponCode (` / `createStripePaymentIntent }`.
        // Argument-less mutations (Vendure's `createStripePaymentIntent`) were
        // missed by the old `name(` form, so they were never limited.
        pattern = new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_])`);
        patternCache.set(name, pattern);
    }
    return pattern;
}

function queriesIn(body: unknown): string[] {
    if (!body) return [];
    const items = Array.isArray(body) ? body : [body];
    const out: string[] = [];
    for (const item of items) {
        if (item && typeof item === 'object' && typeof (item as { query?: unknown }).query === 'string') {
            out.push((item as { query: string }).query);
        }
    }
    return out;
}

/**
 * Returns the configured mutation names a GraphQL request body invokes.
 * Handles single and batched (array) bodies. Only documents containing the
 * `mutation` keyword are inspected, and only field selections with an
 * argument list count, so a query merely mentioning a name is ignored.
 */
/** GraphQL allows `# comments` between any tokens: `applyCouponCode # x\n(` is valid and must still match. */
export function stripGraphQlComments(q: string): string {
    return q.replace(/"{3}[\s\S]*?"{3}/g, '""').replace(/#[^\n\r]*/g, '');
}

/** Rate-limit key for an address: IPv6 clients are bucketed per /64 (one subscriber), IPv4 per address. */
export function rateLimitBucket(ip: string | null): string | null {
    if (!ip) return null;
    if (!ip.includes(':') || ip.startsWith('::ffff:')) return ip;
    const [head, tail = ''] = ip.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const groups = [...left, ...new Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
    return groups.slice(0, 4).map(g => g || '0').join(':') + '::/64';
}

/** Blank out string literals (block and single-line) so a mutation name inside an argument value never counts. */
export function stripStringLiterals(query: string): string {
    return query.replace(/"""[\s\S]*?"""/g, '""').replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

export function extractMutationNames(body: unknown, known: Iterable<string>): string[] {
    const queries = queriesIn(body).map(stripGraphQlComments).map(stripStringLiterals).filter(q => MUTATION_KEYWORD.test(q));
    if (queries.length === 0) return [];
    const found: string[] = [];
    for (const name of known) {
        if (found.includes(name)) continue;
        const pattern = patternFor(name);
        if (queries.some(q => pattern.test(q))) {
            found.push(name);
        }
    }
    return found;
}

/**
 * Blank the names of operation and fragment definitions (`mutation
 * applyCouponCode(...)`, `fragment addPaymentToOrder on ...`) so a document
 * named after the field it calls is counted once, not twice. Only text at
 * brace depth 0 is touched: a field that happens to be called `query`
 * inside a selection set is left alone.
 */
function blankDefinitionNames(q: string): string {
    let out = '';
    let seg = '';
    let depth = 0;
    const flush = () => {
        out += seg.replace(/\b(query|mutation|subscription|fragment)(\s+)[_A-Za-z][_0-9A-Za-z]*/g, '$1$2');
        seg = '';
    };
    for (const ch of q) {
        if (depth === 0) {
            if (ch === '{') { flush(); out += ch; depth++; } else seg += ch;
        } else {
            out += ch;
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
        }
    }
    flush();
    return out;
}

/**
 * How many times each configured mutation is selected in one GraphQL
 * document. Every alias (`a: applyCouponCode(...) b: applyCouponCode(...)`)
 * is a separate resolver call, so each one must spend a token: counting a
 * document once let 50 aliased coupon guesses through for the price of one.
 * Only documents with the `mutation` keyword count; comments and string
 * literals are blanked first.
 */
export function countMutationCalls(query: string, known: Iterable<string>): Map<string, number> {
    const counts = new Map<string, number>();
    if (typeof query !== 'string') return counts;
    const q = blankDefinitionNames(stripStringLiterals(stripGraphQlComments(query)));
    if (!MUTATION_KEYWORD.test(q)) return counts;
    for (const name of known) {
        if (counts.has(name)) continue;
        const global = new RegExp(patternFor(name).source, 'g');
        const n = (q.match(global) || []).length;
        if (n > 0) counts.set(name, n);
    }
    return counts;
}

const APQ_MAX = 10_000;

/** sha256 hex of an Automatic Persisted Query document, as Apollo computes it. */
function sha256Hex(s: string): string {
    return createHash('sha256').update(s).digest('hex');
}

function persistedHash(item: unknown): string | null {
    const h = (item as { extensions?: { persistedQuery?: { sha256Hash?: unknown } } } | null)?.extensions?.persistedQuery?.sha256Hash;
    return typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h) ? h.toLowerCase() : null;
}

/** Body Apollo answers for an unknown APQ hash; APQ clients then resend the full document. */
export function persistedQueryNotFoundBody(): { errors: Array<{ message: string; extensions: { code: string } }> } {
    return { errors: [{ message: 'PersistedQueryNotFound', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }] };
}

/**
 * Mutation call counts for a whole request body (single or batched), with
 * Automatic Persisted Queries resolved through `apq` (hash → counts, filled
 * whenever a document arrives with its hash). `unknownHash` is true when an
 * operation names a hash this process has never seen with its document: it
 * cannot be inspected, so the caller must not let it through.
 */
export function countRequestMutationCalls(
    body: unknown,
    known: string[],
    apq?: Map<string, Map<string, number>>,
): { counts: Map<string, number>; unknownHash: boolean } {
    const counts = new Map<string, number>();
    let unknownHash = false;
    if (!body || typeof body !== 'object') return { counts, unknownHash };
    const items = Array.isArray(body) ? body : [body];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const query = (item as { query?: unknown }).query;
        const hash = persistedHash(item);
        let c: Map<string, number> | undefined;
        if (typeof query === 'string') {
            c = countMutationCalls(query, known);
            if (hash && apq && sha256Hex(query) === hash) {
                if (apq.size >= APQ_MAX && !apq.has(hash)) {
                    const oldest = apq.keys().next().value;
                    if (oldest !== undefined) apq.delete(oldest);
                }
                apq.set(hash, c);
            }
        } else if (hash) {
            c = apq?.get(hash);
            if (!c) { unknownHash = true; continue; }
        }
        for (const [name, n] of c || []) counts.set(name, (counts.get(name) || 0) + n);
    }
    return { counts, unknownHash };
}

export interface MutationRateLimitHandlerOptions {
    /** Host overrides for `DEFAULT_MUTATION_RATE_LIMITS`. */
    limits?: MutationRateLimitOverrides;
    /** Name of the trusted client-IP header (see `TrustedClientIpOptions.header`). Superseded by `clientIp.header`. */
    clientIpHeader?: string;
    /** How the client IP is resolved (trusted header, proxies, Cloudflare) — pass `options.trustedClientIp`. */
    clientIp?: ClientIpResolveOptions;
    /** Custom bucket key; return `null` to skip limiting for that request. Default: client IP. */
    keyFor?: (req: Request) => string | null;
    /** Upper bound on tracked keys per mutation (LRU). Default 10 000. */
    maxKeys?: number;
    /** Log hook; defaults to Vendure's `Logger.warn`. */
    onLimited?: (info: { mutation: string; key: string; limit: MutationRateLimit }) => void;
    /** Card-testing gate (see `card-testing.ts`). Defaults on; pass `false` to disable. */
    cardTesting?: CardTestingOptions | false;
}

/** Body of the 429 response. */
export function rateLimitedBody(mutation: string): { errors: Array<{ message: string; extensions: { code: string; mutation: string } }> } {
    return { errors: [{ message: 'rate_limited', extensions: { code: 'RATE_LIMITED', mutation } }] };
}

/**
 * Express handler for the Shop API path: token-bucket per client IP for each
 * configured mutation, answering `429 { errors: [{ message: 'rate_limited' }] }`
 * with a `Retry-After` header once a bucket is drained. Non-POST requests and
 * bodies without a limited mutation pass straight through.
 */
export function createMutationRateLimitHandler(opts: MutationRateLimitHandlerOptions = {}): RequestHandler {
    const limits = resolveMutationRateLimits(opts.limits);
    const limiters = new Map<string, { limiter: RateLimiter; limit: MutationRateLimit }>();
    for (const [name, limit] of Object.entries(limits)) {
        limiters.set(name, {
            limiter: new RateLimiter({ capacity: limit.capacity, windowMs: limit.windowMs, maxKeys: opts.maxKeys }),
            limit,
        });
    }
    const names = Array.from(limiters.keys());
    const ipOpts: ClientIpResolveOptions = { ...(opts.clientIp || {}), header: opts.clientIp?.header || opts.clientIpHeader };
    const keyFor = opts.keyFor || ((req: Request) => rateLimitBucket(getClientIp(req, ipOpts)));
    const onLimited = opts.onLimited || (({ mutation, key, limit }) => {
        Logger.warn(`Rate limit hit: ${mutation} from ${key} (${limit.capacity}/${Math.round(limit.windowMs / 1000)}s)`, GUARDS_LOGGER_CTX);
    });

    const gateOpts = resolveCardTestingOptions(opts.cardTesting);
    const gate = gateOpts ? new CardTestingGate(gateOpts) : null;
    const known = gate ? Array.from(new Set([...names, ...gate.opts.mutations])) : names;
    /** APQ hash → mutation call counts, learnt from requests that carried the document. */
    const apq = new Map<string, Map<string, number>>();

    const handle = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        if ((names.length === 0 && !gate) || req.method !== 'POST') {
            next();
            return;
        }
        // A multipart (file-upload) GraphQL request hides its document in a
        // form field we do not parse; treat it as invoking every limited
        // mutation so it cannot be used to bypass the limits.
        const contentType = String(req.headers?.['content-type'] || '');
        let counts: Map<string, number>;
        if (/^multipart\/form-data/i.test(contentType)) {
            counts = new Map(known.map(n => [n, 1]));
        } else {
            const r = countRequestMutationCalls(req.body, known, apq);
            if (r.unknownHash) {
                // A persisted-query hash we never saw with its document: the
                // operation cannot be inspected. Answer exactly as Apollo does
                // for an unknown hash so APQ clients resend the full document.
                res.status(200);
                res.setHeader('Cache-Control', 'no-store');
                res.json(persistedQueryNotFoundBody());
                return;
            }
            counts = r.counts;
        }
        const invoked = Array.from(counts.keys());
        if (invoked.length === 0) {
            next();
            return;
        }
        const key = keyFor(req);
        if (!key) {
            next();
            return;
        }
        for (const mutation of invoked) {
            const entry = limiters.get(mutation);
            if (!entry) continue;
            // One token per call: aliased copies and batched operations each pay.
            const calls = counts.get(mutation) || 1;
            let allowed = calls <= entry.limit.capacity;
            for (let i = 0; allowed && i < calls; i++) {
                allowed = entry.limiter.allow(`${mutation}|${key}`);
            }
            if (!allowed) {
                bumpCounter('rate_limit');
                onLimited({ mutation, key, limit: entry.limit });
                res.status(429);
                res.setHeader('Retry-After', String(Math.max(1, Math.ceil(entry.limit.windowMs / 1000))));
                res.setHeader('Cache-Control', 'no-store');
                res.json(rateLimitedBody(mutation));
                return;
            }
        }
        const gated = gate && gate.isActive() ? invoked.filter(m => gate.covers(m)) : [];
        if (gated.length === 0) {
            next();
            return;
        }
        // Only the payment mutations wait on the (cached) failure lookup.
        const ip = getClientIp(req, ipOpts);
        for (const mutation of gated) {
            const verdict = await gate!.check(ip, mutation);
            if (verdict.blocked) {
                Logger.warn(`Card-testing gate: ${mutation} refused for ${ip} (${verdict.failures} failed attempts; blocked until ${verdict.blockedUntil?.toISOString()})`, GUARDS_LOGGER_CTX);
                res.status(429);
                res.setHeader('Retry-After', String(Math.max(60, Math.ceil(((verdict.blockedUntil?.getTime() || Date.now()) - Date.now()) / 1000))));
                res.setHeader('Cache-Control', 'no-store');
                res.json(cardTestingBlockedBody(mutation));
                return;
            }
        }
        next();
    };
    return (req: Request, res: Response, next: NextFunction) => {
        // Synchronous up to the first await, so bucket verdicts and pass-throughs
        // for non-payment mutations still happen before this returns.
        handle(req, res, next).catch(next);
    };
}

/**
 * Vendure `Middleware` entry for `config.apiOptions.middleware`, scoped to the
 * Shop API path (pass `config.apiOptions.shopApiPath`). Runs after the JSON
 * body parser so the GraphQL document is available.
 */
export function shopApiMutationRateLimitMiddleware(
    opts: MutationRateLimitHandlerOptions = {},
    shopApiPath: string = 'shop-api',
): Middleware {
    return {
        route: shopApiPath,
        handler: createMutationRateLimitHandler(opts),
    };
}
