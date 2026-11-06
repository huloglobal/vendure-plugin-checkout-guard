import { ID, PaymentMethod, RequestContext, TransactionalConnection } from '@vendure/core';
import { STRIPE_HOLD_HANDLER_CODE } from './hold-utils';
import { effectiveStripeHoldOptions } from './runtime';

/**
 * Stripe credentials live on the channel's Vendure Stripe PaymentMethod
 * (handler `stripe`, arg `apiKey`) — the hold handler has no args of its
 * own, so a channel with one Stripe account needs one secret in one
 * place. Mirrors the AVS lookup in the fraud-prevention plugin.
 */

function argValue(method: PaymentMethod, name: string): string | undefined {
    const v = method.handler?.args?.find(a => a.name === name)?.value;
    return v ? String(v) : undefined;
}

function inChannel(method: PaymentMethod, channelId: ID | undefined): boolean {
    if (channelId === undefined || channelId === null) return true;
    return (method.channels || []).some(ch => String(ch.id) === String(channelId));
}

/** Every PaymentMethod (any channel) whose handler is `code`. Uses the raw
 *  connection so crons can list without a channel ctx. */
const METHODS_TTL_MS = 30_000;
const methodsCache = new WeakMap<object, { at: number; all: PaymentMethod[] }>();

export async function findMethodsByHandler(connection: TransactionalConnection, handlerCode: string): Promise<PaymentMethod[]> {
    // The table is tiny but a safety-capture pass loads it ~5× per hold; cache it briefly per connection.
    const key = (connection?.rawConnection as object) || connection;
    let hit = methodsCache.get(key);
    if (!hit || Date.now() - hit.at > METHODS_TTL_MS) {
        const all = await connection.rawConnection.getRepository(PaymentMethod).find({ relations: ['channels'] });
        hit = { at: Date.now(), all };
        methodsCache.set(key, hit);
    }
    return hit.all.filter(m => m.handler?.code === handlerCode);
}

/** Tests / method edits: forget the cached payment methods for a connection. */
export function resetMethodsCache(connection?: TransactionalConnection): void {
    if (connection) methodsCache.delete((connection.rawConnection as object) || connection);
}

/** Stripe secret key for the ctx channel, or undefined when the channel
 *  has no enabled Stripe method. A disabled method is still honoured as a
 *  last resort so an admin toggling the card method off does not orphan
 *  holds that still need capturing. */
export async function getStripeKeyForChannel(ctx: RequestContext, connection: TransactionalConnection): Promise<string | undefined> {
    const methods = (await findMethodsByHandler(connection, 'stripe')).filter(m => inChannel(m, ctx.channelId));
    const pick = methods.find(m => m.enabled && argValue(m, 'apiKey')) || methods.find(m => argValue(m, 'apiKey'));
    return pick ? argValue(pick, 'apiKey') : undefined;
}

/** Stripe secret key for an explicit channel id (cron / webhook paths). */
export async function getStripeKeyForChannelId(
    connection: TransactionalConnection, channelId: ID, opts: StripeMethodPickOptions = {},
): Promise<string | undefined> {
    return (await getStripeMethodForChannelId(connection, channelId, opts))?.apiKey;
}

export interface StripeMethodPickOptions {
    /**
     * Prefer the Stripe method that belongs to this channel alone. Vendure also
     * assigns every new payment method to the default channel, so on the
     * default channel a second channel's Stripe method (another Stripe
     * account) can match too. Without this option the first match wins, as it
     * always has for holds and reconciliation.
     */
    preferOwnMethod?: boolean;
}

/** How many channels other than `channelId` and the default channel also use the method. */
function sharedWith(method: PaymentMethod, channelId: ID): number {
    return (method.channels || []).filter(ch => String(ch.id) !== String(channelId) && ch.code !== '__default_channel__').length;
}

/** The Stripe method (code and secret key) the channel's key lookup picks. */
export async function getStripeMethodForChannelId(
    connection: TransactionalConnection, channelId: ID, opts: StripeMethodPickOptions = {},
): Promise<{ code: string; apiKey: string } | undefined> {
    let methods = (await findMethodsByHandler(connection, 'stripe')).filter(m => inChannel(m, channelId) && argValue(m, 'apiKey'));
    // Array sort is stable, so methods that rank equally keep their usual order.
    if (opts.preferOwnMethod) methods = [...methods].sort((a, b) => sharedWith(a, channelId) - sharedWith(b, channelId));
    const pick = methods.find(m => m.enabled) || methods[0];
    const apiKey = pick ? argValue(pick, 'apiKey') : undefined;
    return pick && apiKey ? { code: pick.code, apiKey } : undefined;
}

/** The channel's PaymentMethod that uses the `stripe-hold` handler.
 *  Ties are broken by `options.stripe.holdMethodCode`, then enabled first. */
export async function getHoldPaymentMethodForChannel(
    connection: TransactionalConnection, channelId: ID,
): Promise<PaymentMethod | undefined> {
    const { holdMethodCode } = effectiveStripeHoldOptions();
    const methods = (await findMethodsByHandler(connection, STRIPE_HOLD_HANDLER_CODE)).filter(m => inChannel(m, channelId));
    return methods.find(m => m.code === holdMethodCode && m.enabled)
        || methods.find(m => m.enabled)
        || methods.find(m => m.code === holdMethodCode)
        || methods[0];
}

/** Codes of every PaymentMethod (all channels) backed by the hold handler. */
export async function getHoldMethodCodes(connection: TransactionalConnection): Promise<string[]> {
    return (await findMethodsByHandler(connection, STRIPE_HOLD_HANDLER_CODE)).map(m => m.code);
}
