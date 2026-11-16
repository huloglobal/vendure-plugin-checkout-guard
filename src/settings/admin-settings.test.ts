import { describe, expect, it } from 'vitest';
import { mergeAdminSettings, resolveLoginGuard, resolveOrderLookup, sanitiseAdminSettings, bankEmailsEnabled } from './admin-settings';

describe('sanitiseAdminSettings', () => {
    it('keeps valid values and drops unknown keys', () => {
        const s = sanitiseAdminSettings({
            rateLimits: { store: 'database', mutations: { applyCouponCode: { capacity: 5, windowMs: 60000 }, transitionOrderToState: false } },
            cardTesting: { maxFailedPerIp: 3, autoOrderGate: true },
            loginGuard: { enabled: true, maxFailures: 6, windowMinutes: 10, apis: 'admin' },
            orderLookup: { enabled: true, capacity: 30, windowSeconds: 60 },
            bankTransfer: { expiryDays: 5, reminderAfterDays: 2, emails: true },
            stripe: { safetyCaptureDays: 5, autoCaptureBelowMinor: null },
            reconciliation: { amountDrift: true },
            holds: { huloPayments: true },
            webhookSecret: 'whsec_should_not_pass',
        });
        expect(s).toEqual({
            rateLimits: { store: 'database', mutations: { applyCouponCode: { capacity: 5, windowMs: 60000 }, transitionOrderToState: false } },
            cardTesting: { maxFailedPerIp: 3, autoOrderGate: true },
            loginGuard: { enabled: true, maxFailures: 6, windowMinutes: 10, apis: 'admin' },
            orderLookup: { enabled: true, capacity: 30, windowSeconds: 60 },
            bankTransfer: { expiryDays: 5, reminderAfterDays: 2, emails: true },
            stripe: { safetyCaptureDays: 5, autoCaptureBelowMinor: null },
            reconciliation: { amountDrift: true },
            holds: { huloPayments: true },
        });
    });

    it.each([
        [{ rateLimits: { store: 'redis' } }, /rateLimits.store/],
        [{ rateLimits: { mutations: { 'drop table': { capacity: 1, windowMs: 1000 } } } }, /not a GraphQL field name/],
        [{ rateLimits: { mutations: { applyCouponCode: { capacity: 0, windowMs: 1000 } } } }, /capacity/],
        [{ rateLimits: { mutations: { applyCouponCode: { capacity: 3 } } } }, /both required/],
        [{ cardTesting: { maxFailedPerIp: 'x' } }, /cardTesting.maxFailedPerIp/],
        [{ loginGuard: { enabled: 'yes' } }, /loginGuard.enabled/],
        [{ loginGuard: { apis: 'graphql' } }, /loginGuard.apis/],
        [{ bankTransfer: { expiryDays: 3, reminderAfterDays: 3 } }, /fewer than expiryDays/],
        [{ stripe: { safetyCaptureDays: 9 } }, /stripe.safetyCaptureDays/],
    ])('rejects %j', (input, msg) => {
        expect(() => sanitiseAdminSettings(input)).toThrow(msg);
    });

    it('returns an empty object for nothing', () => {
        expect(sanitiseAdminSettings(null)).toEqual({});
        expect(sanitiseAdminSettings({ loginGuard: {} })).toEqual({});
    });
});

describe('mergeAdminSettings', () => {
    const init = {
        publicBaseUrl: 'https://x',
        stripe: { webhookSecret: 'whsec_x', safetyCaptureDays: 6, autoCaptureBelowMinor: 5000 },
        bankTransfer: { expiryDays: 7, reminderAfterDays: 3, stripe: { enabled: true } },
        rateLimits: { mutations: { applyCouponCode: { capacity: 3, windowMs: 60000 } } },
        cardTesting: { maxFailedPerIp: 4, maxFailedPerOrder: 3 },
    } as any;

    it('returns the init options untouched when nothing is saved', () => {
        expect(mergeAdminSettings(init, {})).toBe(init);
        expect(mergeAdminSettings(init, null)).toBe(init);
    });

    it('lays saved values over the code and keeps everything else (secrets, Stripe bank transfers)', () => {
        const m: any = mergeAdminSettings(init, {
            stripe: { autoCaptureBelowMinor: null, safetyCaptureDays: 5 },
            bankTransfer: { expiryDays: 10 },
            rateLimits: { mutations: { addPaymentToOrder: { capacity: 2, windowMs: 1000 } } },
            cardTesting: { blockMinutes: 60 },
        });
        expect(m.stripe).toEqual({ webhookSecret: 'whsec_x', safetyCaptureDays: 5 });
        expect(m.bankTransfer).toEqual({ expiryDays: 10, reminderAfterDays: 3, stripe: { enabled: true } });
        expect(m.rateLimits.mutations).toEqual({ applyCouponCode: { capacity: 3, windowMs: 60000 }, addPaymentToOrder: { capacity: 2, windowMs: 1000 } });
        expect(m.cardTesting).toEqual({ maxFailedPerIp: 4, maxFailedPerOrder: 3, blockMinutes: 60 });
        expect(init.stripe.autoCaptureBelowMinor).toBe(5000);
    });

    it('switches the card-testing gate off and on', () => {
        expect((mergeAdminSettings(init, { cardTesting: { enabled: false } }) as any).cardTesting).toBe(false);
        const off = { ...init, cardTesting: false };
        expect((mergeAdminSettings(off, { cardTesting: { maxFailedPerIp: 9 } }) as any).cardTesting).toBe(false);
        expect((mergeAdminSettings(off, { cardTesting: { enabled: true, maxFailedPerIp: 9 } }) as any).cardTesting).toEqual({ maxFailedPerIp: 9 });
    });
});

describe('resolvers', () => {
    it('login guard and order lookup are off unless enabled', () => {
        expect(resolveLoginGuard(undefined)).toBeNull();
        expect(resolveLoginGuard({ maxFailures: 3 })).toBeNull();
        expect(resolveLoginGuard({ enabled: true })).toEqual({ maxFailures: 5, windowMs: 900_000, apis: 'both' });
        expect(resolveOrderLookup({ enabled: true, capacity: 2, windowSeconds: 10 })).toEqual({ capacity: 2, windowMs: 10_000 });
        expect(resolveOrderLookup({})).toBeNull();
    });

    it('bank e-mails accept true or { enabled: true }', () => {
        expect(bankEmailsEnabled(true)).toBe(true);
        expect(bankEmailsEnabled({ enabled: true })).toBe(true);
        expect(bankEmailsEnabled(undefined)).toBe(false);
        expect(bankEmailsEnabled({})).toBe(false);
    });
});

describe('e-mail appearance settings', () => {
    it('validates and keeps only set values', () => {
        expect(sanitiseAdminSettings({ email: { storeName: ' Acme ', accentColor: '#ff0066', logoUrl: 'https://cdn.acme.test/l.png', logoWidth: 120, supportEmail: 'help@acme.test', footerText: 'Acme Ltd', storeUrl: '' } }))
            .toEqual({ email: { storeName: 'Acme', accentColor: '#ff0066', logoUrl: 'https://cdn.acme.test/l.png', logoWidth: 120, supportEmail: 'help@acme.test', footerText: 'Acme Ltd' } });
        expect(sanitiseAdminSettings({ email: { storeName: null, accentColor: '' } })).toEqual({});
    });

    it('refuses bad colours, non-https URLs, bad addresses and markup', () => {
        expect(() => sanitiseAdminSettings({ email: { accentColor: 'red' } })).toThrow(/accentColor/);
        expect(() => sanitiseAdminSettings({ email: { logoUrl: 'http://x.test/l.png' } })).toThrow(/logoUrl/);
        expect(() => sanitiseAdminSettings({ email: { logoUrl: 'javascript:alert(1)' } })).toThrow(/logoUrl/);
        expect(() => sanitiseAdminSettings({ email: { supportEmail: 'nobody' } })).toThrow(/supportEmail/);
        expect(() => sanitiseAdminSettings({ email: { footerText: '<script>' } })).toThrow(/footerText/);
        expect(() => sanitiseAdminSettings({ email: { logoWidth: 5000 } })).toThrow(/logoWidth/);
    });

    it('merges over the code options field by field', () => {
        const out = mergeAdminSettings({ email: { storeName: 'Code', footerText: 'Legal' } } as any, { email: { accentColor: '#000000' } });
        expect(out.email).toEqual({ storeName: 'Code', footerText: 'Legal', accentColor: '#000000' });
    });
});
