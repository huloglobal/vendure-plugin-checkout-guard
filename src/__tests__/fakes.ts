import { vi } from 'vitest';

/**
 * Lightweight stand-ins for TransactionalConnection / OrderService /
 * RequestContextService used by the service unit tests. No database: the
 * repositories are in-memory row lists with just enough of TypeORM's
 * `findOne` / query-builder surface to satisfy the services.
 */

type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => String(row[k]) === String(v));
}

export class FakeQueryBuilder {
    private filters: Array<(row: Row) => boolean> = [];
    constructor(private rows: () => Row[], private override?: () => Row | null | undefined) {}
    leftJoinAndSelect() { return this; }
    leftJoin() { return this; }
    setLock() { return this; }
    orderBy() { return this; }
    limit() { return this; }
    where(expr: string, params: Row = {}) { this.filters = [this.filter(expr, params)]; return this; }
    andWhere(expr: string, params: Row = {}) { this.filters.push(this.filter(expr, params)); return this; }
    private filter(expr: string, params: Row): (row: Row) => boolean {
        const eq = expr.match(/^\w+\.(\w+)\s*=\s*:(\w+)$/);
        if (eq) return row => String(row[eq[1]]) === String(params[eq[2]]);
        const inList = expr.match(/^\w+\.(\w+)\s+IN\s*\(:\.\.\.(\w+)\)$/);
        if (inList) return row => (params[inList[2]] || []).map(String).includes(String(row[inList[1]]));
        return () => true;
    }
    async getOne(): Promise<Row | null> {
        if (this.override) {
            const o = this.override();
            if (o !== undefined) return o;
        }
        return this.rows().find(r => this.filters.every(f => f(r))) || null;
    }
    async getMany(): Promise<Row[]> {
        return this.rows().filter(r => this.filters.every(f => f(r)));
    }
}

export class FakeRepo {
    rows: Row[] = [];
    /** When set, `createQueryBuilder().getOne()` returns this instead of matching rows (undefined = fall through). */
    lockOverride?: () => Row | null | undefined;
    find = vi.fn(async (opts?: { where?: Row }) => this.rows.filter(r => matches(r, opts?.where)));
    findOne = vi.fn(async (opts?: { where?: Row }) => this.rows.find(r => matches(r, opts?.where)) || null);
    createQueryBuilder = vi.fn(() => new FakeQueryBuilder(() => this.rows, this.lockOverride));
}

export interface FakeConnectionOptions {
    /** Raw `query(sql, params)` handler; defaults to `[]`. */
    query?: (sql: string, params?: any[]) => any;
    dbType?: string;
}

export class FakeConnection {
    readonly repos = new Map<any, FakeRepo>();
    /** Chronological trace of transaction boundaries + anything tests push. */
    readonly log: string[] = [];
    readonly queries: Array<{ sql: string; params: any[] }> = [];
    readonly rawConnection: any;
    inTransaction = 0;

    constructor(opts: FakeConnectionOptions = {}) {
        this.rawConnection = {
            options: { type: opts.dbType || 'mysql' },
            getRepository: (entity: any) => this.repo(entity),
            query: vi.fn(async (sql: string, params: any[] = []) => {
                this.queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
                return opts.query ? await opts.query(sql, params) : [];
            }),
        };
    }

    repo(entity: any): FakeRepo {
        let r = this.repos.get(entity);
        if (!r) { r = new FakeRepo(); this.repos.set(entity, r); }
        return r;
    }

    getRepository(_ctx: any, entity: any): FakeRepo { return this.repo(entity); }

    withTransaction = vi.fn(async (ctx: any, fn: (ctx: any) => Promise<any>) => {
        this.inTransaction++;
        this.log.push('tx:start');
        try {
            return await fn(ctx);
        } finally {
            this.inTransaction--;
            this.log.push('tx:end');
        }
    });

    /** SQL statements run so far that match `re` (whitespace-normalised). */
    ran(re: RegExp): Array<{ sql: string; params: any[] }> { return this.queries.filter(q => re.test(q.sql)); }
}

export function fakeOrderService(conn?: FakeConnection) {
    const svc = {
        findOneByCode: vi.fn(async (_ctx?: any, _code?: any, _relations?: any) => null as any),
        findOne: vi.fn(async (_ctx?: any, _id?: any, _relations?: any) => null as any),
        transitionToState: vi.fn(async () => ({ state: 'ArrangingPayment' } as any)),
        addPaymentToOrder: vi.fn(async () => null as any),
        settlePayment: vi.fn(async (_ctx: any, paymentId: any) => { conn?.log.push(`settle:${paymentId}`); return { id: paymentId, state: 'Settled' } as any; }),
        cancelPayment: vi.fn(async (_ctx: any, paymentId: any) => { conn?.log.push(`cancelPayment:${paymentId}`); return { id: paymentId, state: 'Cancelled' } as any; }),
        cancelOrder: vi.fn(async (_ctx: any, input: any) => { conn?.log.push(`cancelOrder:${input.orderId}`); return { id: input.orderId, state: 'Cancelled' } as any; }),
    };
    return svc;
}

export function fakeRequestContextService(channels: Array<{ id: any; token: string; code: string }>) {
    return {
        create: vi.fn(async (input: { apiType: string; channelOrToken?: any; languageCode?: string; req?: any }) => {
            const token = typeof input.channelOrToken === 'string' ? input.channelOrToken : input.channelOrToken?.token;
            const ch = channels.find(c => c.token === token) || channels[0];
            return { apiType: input.apiType, channelId: ch?.id, channel: ch, languageCode: input.languageCode, req: input.req };
        }),
    };
}

export function fakeChannelService(channels: Array<{ id: any; token: string; code: string }>) {
    return {
        getChannelFromToken: vi.fn(async (token: string) => {
            const ch = channels.find(c => c.token === token);
            if (!ch) throw new Error('channel not found');
            return ch;
        }),
    };
}

/** An error result as `isGraphQlErrorResult` recognises it. */
export function errorResult(message: string, errorCode = 'ERROR', extra: Row = {}): any {
    return { __typename: errorCode, errorCode, message, ...extra };
}

export async function flushAsync(): Promise<void> {
    await new Promise(r => setTimeout(r, 5));
}

/** One request the code under test sent to the fake Stripe API, decoded. */
export interface StripeCall {
    method: string;
    /** e.g. `/v1/payment_intents` */
    path: string;
    query: Record<string, string>;
    /** The form body decoded (`payment_method_types[0]` → `customer_balance`). */
    form: Record<string, string>;
    headers: Record<string, string>;
    /** The raw form body, exactly as sent. */
    body: string;
}

/** A reply: a status, JSON body and response headers, or `'hang'` (never answers until the request is aborted). */
export type StripeReply = { status?: number; body?: any; headers?: Record<string, string> } | 'hang';

/**
 * Stubs the global `fetch` with a fake api.stripe.com. Nothing leaves the
 * process: every request is recorded in `calls` and answered by `respond`,
 * which tests replace per case. Undo with `vi.unstubAllGlobals()`.
 */
export function installFakeStripe(respond: (call: StripeCall) => StripeReply | Promise<StripeReply> = () => ({ status: 404, body: { error: { message: 'no route' } } })) {
    const calls: StripeCall[] = [];
    const state = { respond };
    const fetchMock = vi.fn((url: string, init: any = {}) => {
        const u = new URL(url);
        const call: StripeCall = {
            method: init.method || 'GET',
            path: u.pathname,
            query: Object.fromEntries(u.searchParams),
            form: Object.fromEntries(new URLSearchParams(init.body || '')),
            headers: { ...(init.headers || {}) },
            body: init.body || '',
        };
        calls.push(call);
        return Promise.resolve(state.respond(call)).then(reply => {
            if (reply === 'hang') {
                return new Promise((_resolve, reject) => {
                    const abort = () => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; reject(e); };
                    if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort);
                });
            }
            const status = reply.status ?? 200;
            const headers = Object.fromEntries(Object.entries(reply.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
            return {
                ok: status >= 200 && status < 300, status, json: async () => reply.body, text: async () => JSON.stringify(reply.body),
                headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
            };
        });
    });
    vi.stubGlobal('fetch', fetchMock);
    return {
        calls,
        fetch: fetchMock,
        respond(fn: (call: StripeCall) => StripeReply | Promise<StripeReply>) { state.respond = fn; },
        /** Calls whose `METHOD /path` matches. */
        to(re: RegExp): StripeCall[] { return calls.filter(c => re.test(`${c.method} ${c.path}`)); },
    };
}

/** A confirmed `customer_balance` PaymentIntent awaiting a UK bank transfer, as Stripe returns it. */
export function stripeBankTransferIntent(over: Record<string, any> = {}): any {
    const { instructions = {}, ...rest } = over;
    return {
        id: 'pi_bt123',
        object: 'payment_intent',
        status: 'requires_action',
        amount: 12999,
        amount_received: 0,
        currency: 'gbp',
        customer: 'cus_123',
        metadata: { cg_bank_transfer: '1', cg_order_code: 'ORD1', cg_order_id: '10', cg_channel_id: '2' },
        next_action: {
            type: 'display_bank_transfer_instructions',
            display_bank_transfer_instructions: {
                type: 'gb_bank_transfer',
                reference: 'RF7K2M9Q4XWZ',
                amount_remaining: 12999,
                currency: 'gbp',
                hosted_instructions_url: 'https://payments.stripe.com/bank_transfers/instructions/test_abc',
                financial_addresses: [{
                    type: 'sort_code',
                    supported_networks: ['bacs', 'fps'],
                    sort_code: { account_holder_name: 'HULO GLOBAL LIMITED', account_number: '98765432', sort_code: '200000' },
                }],
                ...instructions,
            },
        },
        ...rest,
    };
}
