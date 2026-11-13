import { describe, expect, it } from 'vitest';
import { formatStat } from '@huloglobal/vendure-licence-sdk';
import {
    PREMIUM_FEATURES, STAT_KEYS, buildSetupItems, headlineStats, setupTips, toDigestStats, toStatRecord,
} from './engagement';
import type { UsageStats } from './observability/types';

const stats: UsageStats = {
    holdsPlaced: 12, holdsCaptured: 10, holdsCancelled: 1, heldValuePence: 123_456,
    bankTransfersConfirmed: 4, rateLimitRejections: 57, orderAccessDenied: 3, orphansFound: 0, heldCurrency: 'GBP',
};

const facts = {
    publicBaseUrl: 'https://shop.example.com/',
    stripeWebhookSecretConfigured: true,
    holdMethodCodes: ['stripe-hold'],
    bankMethodCodes: ['bank-transfer'],
    trustedClientIpSecretConfigured: false,
    trustedProxiesConfigured: true,
    opsConfigured: true,
};

describe('stats helpers', () => {
    it('reports numbers only, with every key present', () => {
        const r = toStatRecord(stats);
        expect(Object.keys(r).sort()).toEqual([...STAT_KEYS].sort());
        expect(r.heldValuePence).toBe(123_456);
        expect(r.orphansFound).toBe(0);
        expect(toStatRecord({ ...stats, holdsPlaced: -2, heldValuePence: 1.6 } as any).holdsPlaced).toBe(0);
        expect(toStatRecord({ ...stats, holdsPlaced: -2, heldValuePence: 1.6 } as any).heldValuePence).toBe(2);
    });

    it('builds digest rows with the previous week and money formatting', () => {
        const rows = toDigestStats(stats, { ...stats, holdsPlaced: 6, heldValuePence: 0 });
        const held = rows.find(r => r.key === 'heldValuePence')!;
        expect(held.format).toBe('pence');
        expect(formatStat(held)).toBe('£1,234.56');
        expect(rows.find(r => r.key === 'holdsPlaced')!.previous).toBe(6);
        expect(toDigestStats(stats).every(r => r.previous === null)).toBe(true);
    });

    it('puts money first in the headline and skips zero rows', () => {
        const head = headlineStats(stats, 3);
        expect(head.map(h => h.key)).toEqual(['heldValuePence', 'rateLimitRejections', 'holdsPlaced']);
        expect(headlineStats({ ...stats, heldValuePence: 0, holdsPlaced: 0, holdsCaptured: 0, holdsCancelled: 0, bankTransfersConfirmed: 0, rateLimitRejections: 0, orderAccessDenied: 0 })).toEqual([]);
    });

    it('lists the premium features (hold list, capture and release are free since 0.4.0)', () => {
        expect(PREMIUM_FEATURES).toHaveLength(7);
        expect(PREMIUM_FEATURES.join(' ')).toMatch(/Weekly report and setup checklist/);
        expect(PREMIUM_FEATURES.join(' ')).not.toMatch(/authorise-then-capture holds/);
    });
});

describe('setup checklist', () => {
    it('is complete when every real check passes', () => {
        const r = buildSetupItems(facts);
        expect(r.complete).toBe(true);
        expect(r.items.map(i => i.key)).toEqual(['stripe-webhook', 'stripe-hold-method', 'bank-transfer-method', 'trusted-client-ip', 'ops-channel']);
        expect(r.items[0].hint).toContain('https://shop.example.com/checkout-guard/stripe-webhook');
    });

    it('flags missing pieces and points at the right place', () => {
        const r = buildSetupItems({ ...facts, holdMethodCodes: [], trustedProxiesConfigured: false, opsConfigured: false });
        expect(r.complete).toBe(false);
        const open = r.items.filter(i => !i.done).map(i => i.key);
        expect(open).toEqual(['stripe-hold-method', 'trusted-client-ip', 'ops-channel']);
        expect(r.items.find(i => i.key === 'stripe-hold-method')!.url).toBe('/settings/payment-methods');
        expect(r.items.find(i => i.key === 'ops-channel')!.tab).toBe('settings');
    });

    it('accepts either trust model for the client IP', () => {
        expect(buildSetupItems({ ...facts, trustedProxiesConfigured: false, trustedClientIpSecretConfigured: true }).items[3].done).toBe(true);
        expect(buildSetupItems({ ...facts, trustedProxiesConfigured: false, trustedClientIpSecretConfigured: false }).items[3].done).toBe(false);
    });

    it('turns open items into at most three digest tips in order', () => {
        const r = buildSetupItems({ ...facts, stripeWebhookSecretConfigured: false, holdMethodCodes: [], bankMethodCodes: [], opsConfigured: false });
        const tips = setupTips(r.items, 'https://shop.example.com/admin/extensions/checkout-guard');
        expect(tips).toHaveLength(3);
        expect(tips[0].title).toBe('Stripe webhook signing secret');
        expect(tips[0].url).toBe('https://shop.example.com/admin/extensions/checkout-guard');
        expect(setupTips(r.items, null)[0].url).toBeUndefined();
        expect(setupTips(buildSetupItems(facts).items, null)).toEqual([]);
    });
});
