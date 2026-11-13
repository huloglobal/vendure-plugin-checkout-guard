import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbAdapter, translateSql } from '@huloglobal/vendure-licence-sdk';
import { DatabaseLimiterBackend, ensureRateTable } from '../guards/limiter-store';
import { IpBlockService } from '../guards/ip-block.service';

/**
 * Postgres corpus test — runs only when `HULO_PG_URL` points at a scratch
 * PostgreSQL (e.g. `postgres://hulo_pg:hulo_pg_local@localhost:5432/hulo_cg_pg`).
 *
 * Every SQL template literal in `src/**` is extracted, its interpolations
 * replaced with representative values, translated by the licence-sdk
 * dialect adapter and executed for real: the plugin DDL is created, the
 * Vendure tables the plugin reads are stood in with quoted camelCase
 * columns (exactly how TypeORM creates them on Postgres), and each DML
 * statement is PREPAREd to learn its parameter types before it runs with
 * typed placeholder values. Everything happens in one transaction that is
 * rolled back, so the scratch database stays empty.
 */

const PG_URL = process.env.HULO_PG_URL;
const SRC = join(__dirname, '..');

interface Statement { file: string; sql: string; opts: { conflictColumns?: string[]; needInsertId?: boolean; needAffected?: boolean } }

const CONSTANTS: Record<string, string> = {
    PAYMENT_EVENT_TABLE: 'checkout_guard_payment_event',
    FUNNEL_EVENT_TABLE: 'checkout_guard_funnel_event',
    STATE_TABLE: 'checkout_guard_state',
    COUNTER_TABLE: 'cg_counter',
    IP_BLOCK_TABLE: 'cg_ip_block',
    RATE_TABLE: 'cg_rate',
};

/** `${expr}` → SQL fragment. Unknown expressions fail the test so new call sites are handled deliberately. */
function substitute(expr: string, file: string): string {
    const e = expr.trim();
    if (CONSTANTS[e]) return CONSTANTS[e];
    if (/placeholders\(|map\(\(\) => '\?'\)|^ph$/.test(e)) return '?, ?';
    if (/where\.join\(' AND '\)/.test(e)) {
        return file.includes('bank-transfer')
            ? "p.method IN (?, ?) AND EXISTS (SELECT 1 FROM order_channels_channel x WHERE x.`orderId` = o.id AND x.`channelId` = ?) AND p.state = 'Authorized' AND p.`createdAt` >= DATE_SUB(NOW(), INTERVAL ? DAY)"
            : 'createdAt > DATE_SUB(NOW(), INTERVAL ? DAY) AND kind = ? AND channelId = ? AND orderCode = ?';
    }
    if (/^limit$|safeLimit/.test(e)) return '100';
    throw new Error(`${file}: no substitution for \${${e}}`);
}

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== '__tests__' && name !== 'ui') walk(p, out); }
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
    }
    return out;
}

const IS_SQL = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i;
const LOOKS_COMPLETE = /(\bFROM\s+\S+|\bINTO\s+\S+|\bUPDATE\s+\S+\s+SET\b|TABLE IF NOT EXISTS\s+\S+\s*\(|\bINDEX\s+\S+\s+ON\b)/i;

export function extractSqlCorpus(root = SRC): Statement[] {
    const out: Statement[] = [];
    for (const file of walk(root)) {
        const src = readFileSync(file, 'utf8');
        const rel = relative(root, file);
        const literal = /`((?:[^`\\]|\\.)*)`/g;
        let m: RegExpExecArray | null;
        while ((m = literal.exec(src))) {
            const raw = m[1].replace(/\\`/g, '`');
            if (!IS_SQL.test(raw) || raw.includes('…') || !LOOKS_COMPLETE.test(raw)) continue;
            let sql = raw.replace(/\$\{([^}]*)\}/g, (_s, expr) => substitute(expr, rel));
            const after = src.slice(m.index + m[0].length, m.index + m[0].length + 400);
            // Optional clauses appended by string concatenation (`sql += ' AND channelId = ?'`, `' GROUP BY step'`).
            for (const frag of after.matchAll(/sql \+= '([^']*)'/g)) sql += frag[1];
            const opts: Statement['opts'] = {};
            const conflict = after.match(/conflictColumns:\s*\[([^\]]*)\]/);
            if (conflict) opts.conflictColumns = conflict[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
            if (/needInsertId:\s*true/.test(after)) opts.needInsertId = true;
            if (/needAffected:\s*true/.test(after)) opts.needAffected = true;
            out.push({ file: rel, sql, opts });
        }
        // Index DDL kept in plain strings.
        const plain = /'(CREATE (?:UNIQUE )?INDEX[^']*)'/g;
        while ((m = plain.exec(src))) out.push({ file: rel, sql: m[1], opts: {} });
    }
    return out;
}

/** Vendure tables the plugin queries, as TypeORM creates them on Postgres (camelCase columns are quoted). */
const VENDURE_STAND_INS = [
    `CREATE TABLE channel (id SERIAL PRIMARY KEY, "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(), code VARCHAR(255) NOT NULL, token VARCHAR(255) NOT NULL)`,
    `CREATE TABLE customer (id SERIAL PRIMARY KEY, "emailAddress" VARCHAR(255) NOT NULL, "firstName" VARCHAR(255), "lastName" VARCHAR(255))`,
    `CREATE TABLE "order" (id SERIAL PRIMARY KEY, "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(), code VARCHAR(255) NOT NULL, state VARCHAR(255) NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, "currencyCode" VARCHAR(255) NOT NULL, "customerId" INTEGER NULL, "subTotalWithTax" INTEGER NOT NULL DEFAULT 0, "shippingWithTax" INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE order_channels_channel ("orderId" INTEGER NOT NULL, "channelId" INTEGER NOT NULL, PRIMARY KEY ("orderId", "channelId"))`,
    `CREATE TABLE payment (id SERIAL PRIMARY KEY, "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(), method VARCHAR(255) NOT NULL, amount INTEGER NOT NULL, state VARCHAR(255) NOT NULL, "errorMessage" VARCHAR(255), "transactionId" VARCHAR(255), metadata TEXT NOT NULL DEFAULT '{}', "orderId" INTEGER)`,
    `CREATE TABLE payment_method (id SERIAL PRIMARY KEY, code VARCHAR(255) NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE, handler TEXT NOT NULL)`,
    `INSERT INTO channel (code, token) VALUES ('__default_channel__', 'tok-default'), ('elite', 'tok-elite')`,
    `INSERT INTO customer ("emailAddress") VALUES ('a@b.c')`,
    `INSERT INTO "order" (code, state, "currencyCode", "customerId") VALUES ('ORD1', 'PaymentAuthorized', 'GBP', 1), ('ORD2', 'ArrangingPayment', 'GBP', 1)`,
    `INSERT INTO order_channels_channel VALUES (1, 1), (1, 2), (2, 1), (2, 2)`,
    `INSERT INTO payment_method (code, handler) VALUES ('bank-transfer', '{"code":"bank-transfer","args":[]}'), ('stripe-hold', '{"code":"stripe-hold","args":[]}'), ('stripe', '{"code":"stripe","args":[{"name":"apiKey","value":"sk_test"}]}')`,
    `INSERT INTO payment (method, amount, state, "transactionId", metadata, "orderId") VALUES ('bank-transfer', 5000, 'Authorized', NULL, '{"public":{"method":"bank-transfer","payBy":"2026-10-05T00:00:00.000Z"}}', 1), ('stripe-hold', 12345, 'Authorized', 'pi_1', '{"paymentIntentId":"pi_1"}', 2)`,
];

/** The MySQL-isms the translator must not leave behind. */
const LEFTOVERS = /`|\bDATE_SUB\(|\bDATE_ADD\(|INSERT IGNORE|ON DUPLICATE KEY|NOW\(3\)|AUTO_INCREMENT|\bENUM\(|\bINTERVAL\s+\$\d|\bIF\(|GROUP_CONCAT|SUBSTRING_INDEX|AS UNSIGNED|\bDATETIME\b|\bTINYINT\b/i;

function valueFor(pgType: string): any {
    const t = pgType.toLowerCase();
    if (/timestamp|^date$/.test(t)) return '2026-09-28 00:00:00';
    if (/int|numeric|double|real|serial/.test(t)) return 1;
    if (/bool/.test(t)) return true;
    if (/json/.test(t)) return '{}';
    if (/interval/.test(t)) return '1 day';
    return 'x';
}

describe.skipIf(!PG_URL)('Postgres corpus (HULO_PG_URL)', () => {
    let client: any;
    const corpus = extractSqlCorpus();

    beforeAll(async () => {
        // @ts-ignore — pg has no bundled types and is only needed for this opt-in test
        const { Client } = await import('pg');
        client = new Client({ connectionString: PG_URL });
        await client.connect();
        await client.query('BEGIN');
        for (const ddl of VENDURE_STAND_INS) await client.query(ddl);
    });

    afterAll(async () => {
        if (!client) return;
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end().catch(() => undefined);
    });

    it('extracts the whole corpus', () => {
        expect(corpus.length).toBeGreaterThan(30);
        expect(corpus.filter(s => /ON DUPLICATE KEY/i.test(s.sql)).every(s => s.opts.conflictColumns?.length)).toBe(true);
    });

    it('translates every statement without MySQL leftovers and executes it on PostgreSQL 17', async () => {
        const raw = { options: { type: 'postgres' }, query: (sql: string, params?: any[]) => client.query(sql, params).then((r: any) => r.rows) };
        const db = createDbAdapter(raw);
        const failures: string[] = [];
        // DDL first (in source order they already come first per file, but the observability
        // schema is read after bank-transfer; the DML only needs every table to exist).
        const ordered = [...corpus.filter(s => /^\s*CREATE/i.test(s.sql)), ...corpus.filter(s => !/^\s*CREATE/i.test(s.sql))];
        let executed = 0;
        for (const stmt of ordered) {
            const translated = translateSql(stmt.sql, 'postgres', stmt.opts);
            const label = `${stmt.file}: ${stmt.sql.replace(/\s+/g, ' ').trim().slice(0, 110)}`;
            const leftover = translated.match(LEFTOVERS);
            if (leftover) { failures.push(`${label}\n    leftover MySQL syntax "${leftover[0]}" in: ${translated.replace(/\s+/g, ' ').slice(0, 200)}`); continue; }
            await client.query('SAVEPOINT stmt');
            try {
                let params: any[] = [];
                if (!/^\s*CREATE/i.test(translated)) {
                    await client.query(`PREPARE cg_probe AS ${translated}`);
                    const { rows } = await client.query(`SELECT parameter_types::text[] AS types FROM pg_prepared_statements WHERE name = 'cg_probe'`);
                    await client.query('DEALLOCATE cg_probe');
                    params = (rows[0]?.types || []).map(valueFor);
                }
                await db.query(stmt.sql, params, stmt.opts);
                executed++;
            } catch (e: any) {
                failures.push(`${label}\n    ${e?.message || e}\n    translated: ${translated.replace(/\s+/g, ' ').slice(0, 300)}`);
                await client.query('ROLLBACK TO SAVEPOINT stmt');
            }
            await client.query('RELEASE SAVEPOINT stmt').catch(() => undefined);
        }
        // eslint-disable-next-line no-console
        console.log(`PG corpus: ${executed}/${ordered.length} statements executed`);
        expect(failures).toEqual([]);
        expect(executed).toBe(ordered.length);
    });

    it('shared limiter counters and the blocked list behave on PostgreSQL (0.4.0)', async () => {
        await client.query('SAVEPOINT shared');
        try {
            const raw = { options: { type: 'postgres' }, query: (sql: string, params?: any[]) => client.query(sql, params).then((r: any) => r.rows) };
            const db = createDbAdapter(raw);
            await ensureRateTable(db);
            const rate = new DatabaseLimiterBackend(() => db);
            const exp = Date.now() + 60_000;
            expect(await rate.incr('b1', 1, exp)).toBe(1);
            expect(await rate.incr('b1', 2, exp)).toBe(3);
            expect(await rate.peek('b1')).toBe(3);
            await rate.reset('b1');
            expect(await rate.peek('b1')).toBe(0);

            const blocks = new IpBlockService({ rawConnection: raw } as any);
            await blocks.save({ ip: '203.0.113.9', failures: 5, blockedAt: new Date(), blockedUntil: new Date(Date.now() + 3_600_000), surface: 'createStripePaymentIntent' });
            const listed = await blocks.listActive();
            expect(listed.map(b => [b.ip, b.failures, b.surface])).toEqual([['203.0.113.9', 5, 'createStripePaymentIntent']]);
            await blocks.unblock('203.0.113.9');
            const after = await blocks.load();
            expect(after.blocks).toHaveLength(0);
            expect(after.cleared.has('203.0.113.9')).toBe(true);
        } finally {
            await client.query('ROLLBACK TO SAVEPOINT shared');
        }
    });
});
