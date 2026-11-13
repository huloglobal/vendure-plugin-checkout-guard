import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Logger, TransactionalConnection } from '@vendure/core';
import { adapterFor, PluginPrefs } from '@huloglobal/vendure-licence-sdk';
import { SHORT_ID } from '../engagement';
import { AdminSettings, sanitiseAdminSettings } from './admin-settings';

const loggerCtx = 'CheckoutGuard';
export const SETTINGS_PREF_KEY = 'settings.v1';
const POLL_MS = 60_000;

/**
 * Persists the admin's settings (one JSON value in the shared
 * `hulo_plugin_prefs` table) and keeps every process in step: the process
 * that saves applies at once, the others (worker, other server instances)
 * pick the change up within a minute.
 *
 * @docsCategory Services
 * @category Services
 */
@Injectable()
export class SettingsService implements OnModuleDestroy {
    private current: AdminSettings = {};
    private currentJson = '{}';
    private timer: NodeJS.Timeout | null = null;
    private onChange: ((s: AdminSettings) => void) | null = null;
    readonly prefs: PluginPrefs;

    constructor(private connection: TransactionalConnection) {
        this.prefs = new PluginPrefs((sql, params, opts) => adapterFor(this.connection.rawConnection).query(sql, params, opts), SHORT_ID);
    }

    get settings(): AdminSettings { return this.current; }

    /** Load once, apply, then poll. `apply` must not throw. */
    async start(apply: (s: AdminSettings) => void): Promise<void> {
        this.onChange = apply;
        await this.prefs.ensureTable().catch(() => undefined);
        await this.reload();
        if (!this.timer) {
            this.timer = setInterval(() => { void this.reload(); }, POLL_MS);
            if (typeof this.timer.unref === 'function') this.timer.unref();
        }
    }

    /** Re-read the stored value; applies only when it changed. Never throws. */
    async reload(): Promise<void> {
        let raw: string | null = null;
        try { raw = await this.prefs.get(SETTINGS_PREF_KEY); } catch { return; }
        let next: AdminSettings = {};
        if (raw) {
            try { next = sanitiseAdminSettings(JSON.parse(raw)); } catch (e: any) {
                Logger.warn(`Stored Checkout Guard settings ignored (${e?.message || e}); the code's options apply`, loggerCtx);
                next = {};
            }
        }
        this.set(next);
    }

    /** Validate, store and apply. Throws on invalid input (message names the field). */
    async save(input: unknown): Promise<AdminSettings> {
        const clean = sanitiseAdminSettings(input);
        await this.prefs.ensureTable().catch(() => undefined);
        await this.prefs.set(SETTINGS_PREF_KEY, Object.keys(clean).length ? JSON.stringify(clean) : null);
        this.set(clean);
        return clean;
    }

    /** Drop every saved value: the code's options apply again. */
    async reset(): Promise<void> {
        await this.prefs.set(SETTINGS_PREF_KEY, null);
        this.set({});
    }

    private set(next: AdminSettings): void {
        const json = JSON.stringify(next);
        if (json === this.currentJson) return;
        this.current = next;
        this.currentJson = json;
        try { this.onChange?.(next); } catch (e: any) { Logger.warn(`Applying settings failed: ${e?.message || e}`, loggerCtx); }
    }

    onModuleDestroy() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }
}
