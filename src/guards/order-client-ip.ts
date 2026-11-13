import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import {
    CustomFieldConfig, EventBus, LanguageCode, Logger, Order, OrderPlacedEvent, OrderStateTransitionEvent, RequestContext,
    RuntimeVendureConfig, TransactionalConnection,
} from '@vendure/core';
import { Subscription } from 'rxjs';
import { ClientIpResolveOptions, getClientIp } from './client-ip';
import { GUARDS_LOGGER_CTX } from './constants';

/**
 * Client IP stored on the order (opt-in, FREE tier).
 *
 * `orderClientIp: true` registers an Order custom field `cgClientIp`
 * (readonly, visible to administrators, never in the Shop API) and writes the
 * shopper's resolved client IP into it when the order reaches
 * ArrangingPayment and again at placement if it is still empty. Hosts that
 * already keep an IP field (for example `ip`) pass
 * `orderClientIp: { fieldName: 'ip' }`: an existing field of that name is
 * written to and nothing is registered.
 *
 * Off by default: a new Order column needs a migration on hosts that run
 * with `synchronize: false` (column `customFieldsCgclientip`, VARCHAR(64) NULL).
 *
 * With the field in place, card declines that arrive by Stripe webhook are
 * attributed to the order's IP, so the per-IP card-testing gate trips on
 * them too (before, only `/checkout-guard/client-decline` reports carried an IP).
 */
export interface OrderClientIpOptions {
    /** Custom field to write. Default `cgClientIp` (registered by the plugin). */
    fieldName?: string;
}

export const CG_CLIENT_IP_FIELD = 'cgClientIp';
export const CG_CLIENT_IP_COLUMN = 'customFieldsCgclientip';

const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** The field name to write, or null when the feature is off. */
export function orderClientIpField(opt: boolean | OrderClientIpOptions | undefined | null): string | null {
    if (!opt) return null;
    if (opt === true) return CG_CLIENT_IP_FIELD;
    const name = (opt.fieldName || CG_CLIENT_IP_FIELD).trim();
    return FIELD_NAME.test(name) ? name : null;
}

export function cgClientIpCustomField(name: string = CG_CLIENT_IP_FIELD): CustomFieldConfig {
    return {
        name,
        type: 'string',
        length: 64,
        nullable: true,
        public: false,
        readonly: true,
        label: [{ languageCode: LanguageCode.en, value: 'Client IP (Checkout Guard)' }],
        description: [{ languageCode: LanguageCode.en, value: 'The shopper’s IP address as Checkout Guard resolved it (trusted proxy header aware) when the order went to payment.' }],
        ui: { tab: 'Checkout Guard' },
    } as CustomFieldConfig;
}

/** Register the field unless the host already has one of that name. Idempotent. */
export function registerOrderClientIpField(config: RuntimeVendureConfig, opt: boolean | OrderClientIpOptions | undefined | null): string | null {
    const name = orderClientIpField(opt);
    if (!name) return null;
    const existing = config.customFields.Order || [];
    if (!existing.some(f => f.name === name)) config.customFields.Order = existing.concat([cgClientIpCustomField(name)]);
    return name;
}

export interface OrderClientIpRuntime {
    field: () => string | null;
    clientIp: () => ClientIpResolveOptions;
}

let runtime: OrderClientIpRuntime = { field: () => null, clientIp: () => ({}) };

export function setOrderClientIpRuntime(rt: OrderClientIpRuntime): void {
    runtime = rt;
}

export function getOrderClientIpRuntime(): OrderClientIpRuntime {
    return runtime;
}

/** Read the stored IP off an order (null when the feature is off or empty). */
export function readOrderClientIp(order: { customFields?: unknown } | null | undefined): string | null {
    const name = runtime.field();
    if (!name) return null;
    const v = (order?.customFields as Record<string, unknown> | undefined)?.[name];
    return typeof v === 'string' && v ? v : null;
}

@Injectable()
export class OrderClientIpSubscriber implements OnApplicationBootstrap, OnModuleDestroy {
    private subs: Subscription[] = [];

    constructor(private eventBus: EventBus, private connection: TransactionalConnection) {}

    onApplicationBootstrap(): void {
        this.subs.push(this.eventBus.ofType(OrderStateTransitionEvent).subscribe(ev => {
            if (ev.toState === 'ArrangingPayment') void this.write(ev.ctx, ev.order, true).catch(e => this.warn(ev.order, e));
        }));
        this.subs.push(this.eventBus.ofType(OrderPlacedEvent).subscribe(ev => {
            void this.write(ev.ctx, ev.order, false).catch(e => this.warn(ev.order, e));
        }));
    }

    onModuleDestroy(): void {
        for (const s of this.subs) s.unsubscribe();
        this.subs = [];
    }

    /** Returns the IP written, or null. Only Shop API requests carry the shopper's address. */
    async write(ctx: RequestContext, order: Order | undefined, overwrite: boolean): Promise<string | null> {
        const name = runtime.field();
        if (!name || !order?.id || ctx.apiType !== 'shop' || !ctx.req) return null;
        if (!overwrite && readOrderClientIp(order)) return null;
        const ip = getClientIp(ctx.req as any, runtime.clientIp());
        if (!ip) return null;
        if (readOrderClientIp(order) === ip) return ip;
        await this.connection.getRepository(ctx, Order).update({ id: order.id }, { customFields: { [name]: ip.slice(0, 64) } } as any);
        if (order.customFields && typeof order.customFields === 'object') (order.customFields as Record<string, unknown>)[name] = ip;
        return ip;
    }

    private warn(order: Order | undefined, e: any): void {
        Logger.warn(`Could not store the client IP on order ${order?.code ?? '?'}: ${e?.message || e}`, GUARDS_LOGGER_CTX);
    }
}
