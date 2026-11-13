import { Injectable } from '@nestjs/common';
import { Logger, TransactionalConnection } from '@vendure/core';
import { adapterFor, DbAdapter } from '@huloglobal/vendure-licence-sdk';
import type { CardTestingBlock, CardTestingBlockStore } from './card-testing';
import { GUARDS_LOGGER_CTX } from './constants';
import { normaliseIp } from './client-ip';

export const IP_BLOCK_TABLE = 'cg_ip_block';

/** How long an unblock is remembered (failures before it stop counting). */
const CLEARED_KEEP_DAYS = 2;

export interface IpBlockRow {
    ip: string;
    /** `createStripePaymentIntent` / `addPaymentToOrder` (card-testing gate) or `login:admin` / `login:shop` (login guard). */
    surface: string;
    failures: number;
    blockedAt: string;
    blockedUntil: string;
}

/**
 * The blocked-connection list shared by every process: card-testing blocks
 * and login lockouts, plus the admin's unblocks (`clearedAt`). Plain SQL
 * through the SDK dialect adapter, one row per address.
 *
 * Times are written by the database clock (`NOW(3)` / `DATE_ADD(NOW(3), …)`)
 * so a Node process in another time zone cannot skew them.
 *
 * @docsCategory Services
 * @category Services
 */
@Injectable()
export class IpBlockService implements CardTestingBlockStore {
    private ready: Promise<void> | null = null;
    private lastPrune = 0;

    constructor(private connection: TransactionalConnection) {}

    private get db(): DbAdapter {
        return adapterFor(this.connection.rawConnection);
    }

    async ensureTable(): Promise<void> {
        if (!this.ready) {
            this.ready = this.db.query(`
                CREATE TABLE IF NOT EXISTS ${IP_BLOCK_TABLE} (
                    ip VARCHAR(64) NOT NULL PRIMARY KEY,
                    surface VARCHAR(64) NOT NULL,
                    failures INT NOT NULL DEFAULT 0,
                    blockedAt DATETIME(3) NOT NULL,
                    blockedUntil DATETIME(3) NOT NULL,
                    clearedAt DATETIME(3) NULL,
                    INDEX idx_cg_ip_block_until (blockedUntil)
                )
            `).then(() => undefined).catch(e => { this.ready = null; throw e; });
        }
        return this.ready;
    }

    /** Record (or extend) a block. Never throws. */
    async save(block: CardTestingBlock): Promise<void> {
        const ip = normaliseIp(block.ip) || String(block.ip || '').slice(0, 64);
        if (!ip) return;
        const seconds = Math.max(1, Math.ceil((block.blockedUntil.getTime() - Date.now()) / 1000));
        try {
            await this.ensureTable();
            await this.db.query(
                `INSERT INTO ${IP_BLOCK_TABLE} (ip, surface, failures, blockedAt, blockedUntil, clearedAt)
                 VALUES (?, ?, ?, NOW(3), DATE_ADD(NOW(3), INTERVAL ? SECOND), NULL)
                 ON DUPLICATE KEY UPDATE surface = VALUES(surface), failures = VALUES(failures), blockedAt = VALUES(blockedAt), blockedUntil = VALUES(blockedUntil)`,
                [ip, String(block.surface || '').slice(0, 64), Math.max(0, Math.floor(block.failures) || 0), seconds],
                { conflictColumns: ['ip'] },
            );
        } catch (e: any) {
            Logger.warn(`Could not store the block of ${ip}: ${e?.message || e}`, GUARDS_LOGGER_CTX);
        }
    }

    /** Blocks in force plus recent unblocks, for the gate's sync. */
    async load(): Promise<{ blocks: CardTestingBlock[]; cleared: Map<string, Date> }> {
        await this.ensureTable();
        // Retention rides on the gate's sync: ended rows go once a day.
        if (Date.now() - this.lastPrune > 86_400_000) {
            this.lastPrune = Date.now();
            void this.prune().catch(() => undefined);
        }
        const rows: any[] = await this.db.query(
            `SELECT ip, surface, failures, blockedAt, blockedUntil, clearedAt,
                    TIMESTAMPDIFF(SECOND, NOW(3), blockedUntil) AS secondsLeft,
                    TIMESTAMPDIFF(SECOND, blockedAt, NOW(3)) AS secondsAgo,
                    TIMESTAMPDIFF(SECOND, clearedAt, NOW(3)) AS clearedAgo
             FROM ${IP_BLOCK_TABLE}
             WHERE blockedUntil > NOW(3) OR clearedAt > DATE_SUB(NOW(3), INTERVAL ? DAY)
             ORDER BY blockedUntil DESC
             LIMIT 2000`,
            [CLEARED_KEEP_DAYS],
        );
        const now = Date.now();
        const blocks: CardTestingBlock[] = [];
        const cleared = new Map<string, Date>();
        for (const r of rows || []) {
            const ip = String(r.ip);
            // Times relative to the database clock, re-anchored on this process's clock.
            if (r.clearedAgo !== null && r.clearedAgo !== undefined) cleared.set(ip, new Date(now - Number(r.clearedAgo) * 1000));
            const left = Number(r.secondsLeft);
            if (!(left > 0)) continue;
            if (r.clearedAgo !== null && r.clearedAgo !== undefined && Number(r.clearedAgo) <= Number(r.secondsAgo)) continue;
            blocks.push({
                ip,
                surface: String(r.surface || ''),
                failures: Number(r.failures || 0),
                blockedAt: new Date(now - Math.max(0, Number(r.secondsAgo) || 0) * 1000),
                blockedUntil: new Date(now + left * 1000),
            });
        }
        return { blocks, cleared };
    }

    /** Blocks in force, newest first, for the admin list. */
    async listActive(limit = 200): Promise<IpBlockRow[]> {
        const { blocks } = await this.load();
        return blocks
            .sort((a, b) => b.blockedAt.getTime() - a.blockedAt.getTime())
            .slice(0, Math.max(1, Math.min(500, limit)))
            .map(b => ({ ip: b.ip, surface: b.surface, failures: b.failures, blockedAt: b.blockedAt.toISOString(), blockedUntil: b.blockedUntil.toISOString() }));
    }

    /** Lift a block: the row ends now and remembers when, so earlier failures stop counting. */
    async unblock(ip: string): Promise<void> {
        await this.ensureTable();
        await this.db.query(
            `INSERT INTO ${IP_BLOCK_TABLE} (ip, surface, failures, blockedAt, blockedUntil, clearedAt)
             VALUES (?, 'unblocked', 0, NOW(3), NOW(3), NOW(3))
             ON DUPLICATE KEY UPDATE blockedUntil = VALUES(blockedUntil), clearedAt = VALUES(clearedAt)`,
            [ip],
            { conflictColumns: ['ip'] },
        );
    }

    /** Daily retention: ended blocks whose unblock (if any) is older than two days. */
    async prune(): Promise<number> {
        await this.ensureTable();
        const r = await this.db.query(
            `DELETE FROM ${IP_BLOCK_TABLE}
             WHERE blockedUntil < DATE_SUB(NOW(3), INTERVAL ? DAY)
               AND (clearedAt IS NULL OR clearedAt < DATE_SUB(NOW(3), INTERVAL ? DAY))`,
            [CLEARED_KEEP_DAYS, CLEARED_KEEP_DAYS],
            { needAffected: true },
        ).catch(() => null);
        return Number(r?.affectedRows || 0);
    }
}
