import { describe, expect, it, vi } from 'vitest';

vi.mock('@vendure/core', () => ({ Logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), verbose: vi.fn() } }));

import { composeOpsAlertEmail } from './ops-alert.service';

describe('ops alert e-mail (compact admin style)', () => {
    it('keeps the subject, adds a plain-text part and the compact layout', () => {
        const m = composeOpsAlertEmail({
            event: 'bank.stripe_unsettled', orderCode: 'ORD7', amountMinor: 12999, currency: 'GBP', channelId: 2, paymentIntentId: 'pi_123',
            text: 'Money at Stripe without a settled order.\nCheck it today.',
        }, { storeName: 'Acme', accentColor: '#00aa55' });
        expect(m.subject).toBe('[Checkout Guard] bank.stripe_unsettled — ORD7');
        expect(m.html).toContain('font-size:18px');
        expect(m.html).toContain('border-bottom:3px solid #00aa55');
        expect(m.html).not.toContain('Kind regards');
        expect(m.html).toContain('£129.99');
        expect(m.text).toContain('Money at Stripe without a settled order.\nCheck it today.');
        expect(m.text).toContain('Order: ORD7');
        expect(m.text).toContain('Reference: pi_123');
        expect(m.text).toContain('Event: bank.stripe_unsettled');
    });

    it('escapes the alert text and the order code', () => {
        const m = composeOpsAlertEmail({ event: 'webhook.error', text: '<img src=x onerror=alert(1)>', orderCode: '<b>' });
        expect(m.html).not.toContain('<img src=x');
        expect(m.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(m.html).toContain('&lt;b&gt;');
    });
});
