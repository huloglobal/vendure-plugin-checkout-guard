import { describe, expect, it } from 'vitest';

import { CheckoutGuardService } from './checkout-guard.service';

/**
 * On PostgreSQL the licence SDK rewrites `ON DUPLICATE KEY UPDATE` as
 * `ON CONFLICT (...) DO UPDATE`, using the conflict columns that
 * `LicenceStore.save` passes as the query function's third argument. A
 * wrapper that dropped that argument made every save throw there, so a key
 * activated in the admin was applied but never stored.
 */

/** A raw connection that reports Postgres and keeps `hulo_licence_store` in a map. */
function postgres() {
    const rows = new Map<string, string>();
    const upserts: string[] = [];
    const rawConnection = {
        options: { type: 'postgres' },
        async query(sql: string, params: any[] = []) {
            if (sql.startsWith('INSERT INTO hulo_licence_store')) {
                upserts.push(sql);
                rows.set(params[0], params[1]);
            }
            if (sql.startsWith('SELECT licenceKey FROM hulo_licence_store')) {
                // Postgres folds unquoted names to lower case; the SDK's adapter restores them.
                return rows.has(params[0]) ? [{ licencekey: rows.get(params[0]) }] : [];
            }
            return [];
        },
    };
    return { connection: { rawConnection } as any, rows, upserts };
}

describe('licence key store on PostgreSQL', () => {
    it('stores an activated key with an ON CONFLICT upsert and reads it back', async () => {
        const db = postgres();
        await expect(new CheckoutGuardService(db.connection, {} as any, {} as any).saveStoredLicenceKey('a.licence.key')).resolves.toBeUndefined();
        expect(db.upserts).toEqual([expect.stringContaining('ON CONFLICT (pluginId) DO UPDATE SET')]);
        // A second instance on the same database stands in for the next boot.
        await expect(new CheckoutGuardService(db.connection, {} as any, {} as any).loadStoredLicenceKey()).resolves.toBe('a.licence.key');
    });
});
