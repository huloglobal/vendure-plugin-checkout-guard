import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import * as vendureCore from '@vendure/core';
import {
    ActiveOrderService, I18nError, Logger, LogLevel, PaymentMethod, RequestContext, TransactionalConnection,
} from '@vendure/core';
import { from, Observable } from 'rxjs';
import { mergeMap, tap } from 'rxjs/operators';
import { ClientIpResolveOptions, getClientIp } from './client-ip';
import { GUARDS_LOGGER_CTX } from './constants';
import { bumpCounter } from './counters';
import { hitFixedWindow, peekFixedWindow } from './limiter-store';
import { rateLimitBucket } from './mutation-rate-limit';
import { ResolvedCardTestingOptions } from './card-testing';
import type { LoginGuardOptions, OrderLookupLimitOptions } from '../settings/admin-settings';
import { resolveLoginGuard, resolveOrderLookup } from '../settings/admin-settings';

/**
 * GraphQL-level guards (FREE tier, each off until switched on):
 *
 *   • Login guard: failed `login` / `authenticate` mutations (Admin and/or
 *     Shop API) count per client connection (an IPv4 address or an IPv6 /64);
 *     at `maxFailures` inside the window further logins from it are refused,
 *     even with the right password, until the window ends.
 *   • `orderByCode` lookup limit: Shop API order lookups per connection.
 *   • Automatic per-order card-testing gate: once the active order has
 *     `maxFailedPerOrder` failed card attempts in the window,
 *     `createStripePaymentIntent` and card `addPaymentToOrder` calls are
 *     refused without the host wiring `cardTestingVerdict` into its Stripe
 *     hook. Bank-transfer payments are never refused by it.
 *
 * Refusals are GraphQL errors with `extensions.code = 'RATE_LIMITED'`.
 * Every check fails open: an error while counting lets the request through.
 */
export class CheckoutGuardRateLimitError extends I18nError {
    constructor(message: string, public readonly reason: 'login' | 'order_lookup' | 'card_testing', public readonly retryAfterSec?: number) {
        super(message, {}, 'RATE_LIMITED', LogLevel.Verbose);
    }
}

export interface GraphqlGuardRuntime {
    loginGuard(): LoginGuardOptions | undefined;
    orderLookup(): OrderLookupLimitOptions | undefined;
    /** Resolved card-testing options when the automatic order gate is on, else null. */
    autoOrderGate(): ResolvedCardTestingOptions | null;
    clientIp(): ClientIpResolveOptions;
    countOrderFailures(orderCode: string, windowMinutes: number): Promise<number>;
    /** A connection was just locked out of logging in (blocked list + ops). */
    onLoginLockout(info: { ip: string; api: 'admin' | 'shop'; failures: number; until: Date }): void;
}

let runtime: GraphqlGuardRuntime | null = null;

export function setGraphqlGuardRuntime(rt: GraphqlGuardRuntime | null): void {
    runtime = rt;
}

export const LOGIN_FIELDS = new Set(['login', 'authenticate']);
export const ORDER_GATE_FIELDS = new Set(['createStripePaymentIntent', 'addPaymentToOrder']);
const LOGIN_FAILURE_CODES = new Set(['INVALID_CREDENTIALS_ERROR']);

/** True when a login resolver result is a failed credential check. */
export function isFailedLogin(result: unknown): boolean {
    const code = (result as { errorCode?: unknown } | null)?.errorCode;
    return typeof code === 'string' && LOGIN_FAILURE_CODES.has(code);
}

export function loginRule(api: 'admin' | 'shop'): string {
    return `login:${api}`;
}

@Injectable()
export class CheckoutGuardGraphqlInterceptor implements NestInterceptor {
    private methodHandlers = new Map<string, { handler: string; at: number }>();

    constructor(private activeOrderService: ActiveOrderService, private connection: TransactionalConnection) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const rt = runtime;
        if (!rt || context.getType<string>() !== 'graphql') return next.handle();
        const args = context.getArgs();
        const info = args?.[3];
        const parent: string | undefined = info?.parentType?.name;
        const field: string | undefined = info?.fieldName;
        if (!field || (parent !== 'Mutation' && parent !== 'Query')) return next.handle();
        const isLogin = parent === 'Mutation' && LOGIN_FIELDS.has(field);
        const isLookup = parent === 'Query' && field === 'orderByCode';
        const isPayment = parent === 'Mutation' && ORDER_GATE_FIELDS.has(field);
        if (!isLogin && !isLookup && !isPayment) return next.handle();

        const req = args?.[2]?.req;
        let ctx: RequestContext | undefined;
        try { ctx = req ? requestContextOf(req, context) : undefined; } catch { ctx = undefined; }
        const api: 'admin' | 'shop' | null = ctx?.apiType === 'admin' ? 'admin' : ctx?.apiType === 'shop' ? 'shop' : null;
        if (!api) return next.handle();

        if (isLogin) {
            const opts = safe(() => resolveLoginGuard(rt.loginGuard()), null);
            if (!opts || (opts.apis !== 'both' && opts.apis !== api)) return next.handle();
            const key = rateLimitBucket(getClientIp(req, rt.clientIp()));
            if (!key) return next.handle();
            const rule = loginRule(api);
            return from(peekFixedWindow(rule, key, opts.windowMs).catch(() => 0)).pipe(mergeMap(n => {
                if (n >= opts.maxFailures) {
                    bumpCounter('rate_limit');
                    throw new CheckoutGuardRateLimitError('Too many failed login attempts from your connection. Please wait a few minutes and try again.', 'login');
                }
                // Vendure's transaction interceptor emits the resolver's Promise, not its value: settle it first.
                return next.handle().pipe(tap(result => {
                    void Promise.resolve(result).then(value => {
                        if (!isFailedLogin(value)) return;
                        return hitFixedWindow(rule, key, opts.windowMs).then(r => {
                            if (r.count === opts.maxFailures) {
                                Logger.warn(`Login guard: ${api} logins from ${key} refused for up to ${Math.round(opts.windowMs / 60_000)} min after ${r.count} failed attempts`, GUARDS_LOGGER_CTX);
                                try { rt.onLoginLockout({ ip: key, api, failures: r.count, until: new Date(Date.now() + r.retryAfterSec * 1000) }); } catch { /* never affects the request */ }
                            }
                        });
                    }).catch(() => undefined);
                }));
            }));
        }

        if (isLookup) {
            if (api !== 'shop') return next.handle();
            const opts = safe(() => resolveOrderLookup(rt.orderLookup()), null);
            if (!opts) return next.handle();
            const key = rateLimitBucket(getClientIp(req, rt.clientIp()));
            if (!key) return next.handle();
            return from(hitFixedWindow('orderByCode', key, opts.windowMs).catch(() => null)).pipe(mergeMap(r => {
                if (r && r.count > opts.capacity) {
                    bumpCounter('rate_limit');
                    if (r.count === opts.capacity + 1) Logger.warn(`orderByCode limit hit by ${key} (${opts.capacity}/${Math.round(opts.windowMs / 1000)}s)`, GUARDS_LOGGER_CTX);
                    throw new CheckoutGuardRateLimitError('Too many order lookups. Please wait a minute and try again.', 'order_lookup', r.retryAfterSec);
                }
                return next.handle();
            }));
        }

        // Automatic per-order card-testing gate.
        if (api !== 'shop' || !ctx) return next.handle();
        const gate = safe(() => rt.autoOrderGate(), null);
        if (!gate || gate.maxFailedPerOrder <= 0) return next.handle();
        const method: string | undefined = field === 'addPaymentToOrder' ? args?.[1]?.input?.method : undefined;
        const c = ctx;
        return from(this.orderBlocked(c, gate, rt, field, method, args?.[1]).catch(() => false)).pipe(mergeMap(blocked => {
            if (blocked) {
                bumpCounter('card_testing_block');
                throw new CheckoutGuardRateLimitError('Too many failed payment attempts on this order. Please contact us to complete your purchase.', 'card_testing');
            }
            return next.handle();
        }));
    }

    private async orderBlocked(ctx: RequestContext, gate: ResolvedCardTestingOptions, rt: GraphqlGuardRuntime, field: string, method: string | undefined, args: any): Promise<boolean> {
        if (field === 'addPaymentToOrder') {
            if (!method) return false;
            const handler = await this.handlerOf(method);
            // Only card payments are gated: a customer whose cards failed may still pay by bank transfer.
            if (!handler || handler === 'bank-transfer' || /bank|transfer|invoice|pay-later|offline/i.test(handler)) return false;
        }
        const order = await this.activeOrderService.getActiveOrder(ctx, args?.activeOrderInput ?? undefined);
        if (!order?.code) return false;
        const n = await rt.countOrderFailures(order.code, gate.windowMinutes);
        if (n >= gate.maxFailedPerOrder) {
            Logger.warn(`Card-testing gate: ${field} refused for order ${order.code} (${n} failed attempts in ${gate.windowMinutes} min)`, GUARDS_LOGGER_CTX);
            return true;
        }
        return false;
    }

    /** Payment-method code → handler code, cached for a minute. */
    private async handlerOf(code: string): Promise<string | null> {
        const hit = this.methodHandlers.get(code);
        if (hit && Date.now() - hit.at < 60_000) return hit.handler;
        const m = await this.connection.rawConnection.getRepository(PaymentMethod).findOne({ where: { code } }).catch(() => null);
        const handler = m?.handler?.code ?? '';
        if (this.methodHandlers.size > 500) this.methodHandlers.clear();
        this.methodHandlers.set(code, { handler, at: Date.now() });
        return handler || null;
    }
}

/** Vendure's RequestContext for a request (public helper where the core exports it, else the request store). */
function requestContextOf(req: any, context: ExecutionContext): RequestContext | undefined {
    const getter = (vendureCore as any).internal_getRequestContext;
    if (typeof getter === 'function') return getter(req, context);
    const store = req?.vendureRequestContext;
    return store instanceof RequestContext ? store : store?.default;
}

function safe<T>(fn: () => T, fallback: T): T {
    try { return fn(); } catch { return fallback; }
}
