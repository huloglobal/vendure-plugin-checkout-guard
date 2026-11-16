import { afterEach, describe, expect, it, vi } from 'vitest';
import { BankTransferEmailSubscriber, composeBankEmail, formatAmount, setBankEmailRuntime } from './bank-emails';

vi.mock('@vendure/core', () => ({ Order: class Order {}, Logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }, VendureEvent: class {} }));

const details = {
    method: 'bank-transfer', accountName: 'HULO Ltd', sortCode: '12-34-56', accountNumber: '12345678', reference: 'REF123',
    amountMinor: 12999, currency: 'GBP', payBy: '2026-11-20T00:00:00.000Z', expiryDays: 7,
};

afterEach(() => setBankEmailRuntime({ enabled: () => false, hasPremiumAccess: () => false }));

describe('bank transfer e-mails (premium, opt-in)', () => {
    it('composes the reminder with the account details and the pay-by date', () => {
        const m = composeBankEmail('reminder', { orderCode: 'ORD1', payBy: new Date('2026-11-20T00:00:00Z'), details: details as any, storeName: 'shop.example' });
        expect(m.subject).toBe('Reminder: your bank transfer for order ORD1');
        expect(m.text).toContain('Sort code: 12-34-56');
        expect(m.text).toContain('Reference: REF123');
        expect(m.text).toContain('£129.99');
        expect(m.text).toContain('20 November 2026');
        expect(m.html).toContain('>12345678</td>');
    });

    it('shows the order\'s own bank details and reference in the shared design, with a plain-text twin', () => {
        const m = composeBankEmail('reminder', {
            orderCode: 'ORD1', payBy: new Date('2026-11-20T00:00:00Z'),
            details: { ...details, iban: 'GB00TEST00000012345678', bic: 'TESTGB2L', instructions: 'Allow two working days.', hostedInstructionsUrl: 'https://pay.stripe.com/instr/x' } as any,
            branding: { storeName: 'Acme Ltd', accentColor: '#ff0066', supportEmail: 'help@acme.test', footerText: 'Acme Ltd, 1 High St' },
        });
        // Layout: 600px card, grey page, accent bar, store name header, footer strip.
        expect(m.html).toContain('max-width:600px');
        expect(m.html).toContain('background-color:#f3f4f6');
        expect(m.html).toContain('border-bottom:3px solid #ff0066');
        expect(m.html).toContain('Acme Ltd, 1 High St');
        expect(m.html).not.toMatch(/<style/i);
        // Warning box with every bank row; the reference in monospace and the accent colour.
        expect(m.html).toContain('background-color:#fffbeb;border:1px solid #fde68a');
        for (const v of ['HULO Ltd', '12-34-56', '12345678', 'GB00TEST00000012345678', 'TESTGB2L', 'Allow two working days.']) expect(m.html).toContain(v);
        expect(m.html).toMatch(/font-family:Consolas[^"]*color:#ff0066;[^"]*">REF123</);
        expect(m.html).toContain('href="https://pay.stripe.com/instr/x"');
        expect(m.html).toContain('Kind regards,');
        expect(m.html).toContain('mailto:help@acme.test');
        // Plain text carries the same facts.
        expect(m.text).toContain('IBAN: GB00TEST00000012345678');
        expect(m.text).toContain('BIC: TESTGB2L');
        expect(m.text).toContain('Please pay by: 20 November 2026');
        expect(m.text).toContain('Payment instructions: https://pay.stripe.com/instr/x');
        expect(m.text).toContain('Kind regards,\nAcme Ltd\nhelp@acme.test');
        expect(m.text).not.toMatch(/<[a-z]/i);
    });

    it('escapes every interpolated value and drops unsafe URLs and colours', () => {
        const m = composeBankEmail('reminder', {
            orderCode: 'O"1', payBy: new Date('2026-11-20T00:00:00Z'),
            details: { ...details, accountName: '<script>x</script>', hostedInstructionsUrl: 'javascript:alert(1)' } as any,
            branding: { storeName: '<b>Shop</b>', accentColor: 'red;background:url(x)', logoUrl: 'http://x" onerror="y' },
        });
        expect(m.html).not.toContain('<script>');
        expect(m.html).toContain('&lt;script&gt;x&lt;/script&gt;');
        expect(m.html).toContain('&lt;b&gt;Shop&lt;/b&gt;');
        expect(m.html).not.toContain('javascript:');
        expect(m.html).not.toContain('onerror');
        expect(m.html).not.toContain('red;background');
        expect(m.html).toContain('#155dfc');
    });

    it('uses the logo when one is configured, and points to the order confirmation when there are no account details', () => {
        const m = composeBankEmail('reminder', {
            orderCode: 'ORD9', payBy: new Date('2026-11-20T00:00:00Z'), details: null, amountMinor: 2500, currency: 'GBP',
            branding: { storeName: 'Acme', logoUrl: 'https://cdn.acme.test/logo.png', logoWidth: 120 },
        });
        expect(m.html).toContain('<img src="https://cdn.acme.test/logo.png" alt="Acme" width="120"');
        expect(m.text).toContain('Reference: ORD9');
        expect(m.text).toContain('Please use the bank details from your order confirmation.');
    });

    it('falls back to the runtime store name when no branding name is set', () => {
        const m = composeBankEmail('expired', { orderCode: 'ORD1', payBy: new Date('2026-11-20T00:00:00Z'), details: null, storeName: 'shop.example', amountMinor: 100, currency: 'GBP' });
        expect(m.text).toContain('Kind regards,\nshop.example');
        expect(m.html).toContain('Was due by');
    });

    it('composes the expiry notice and escapes HTML', () => {
        const m = composeBankEmail('expired', { orderCode: 'O<1>', payBy: new Date('2026-11-20T00:00:00Z'), details: null, amountMinor: 500, currency: 'EUR' });
        expect(m.subject).toBe('Your order O<1> has been cancelled');
        expect(m.html).toContain('O&lt;1&gt;');
        expect(m.text).toContain('Order: O<1>');
        expect(m.text).toContain('€5.00');
    });

    it('formats zero-decimal currencies', () => {
        expect(formatAmount(1500, 'JPY')).toBe('JP¥1,500');
    });

    it('sends only when switched on AND premium is active', async () => {
        const send = vi.fn(async () => undefined);
        const sub = new BankTransferEmailSubscriber({} as any, {} as any);
        const order: any = { id: 1, code: 'ORD1', currencyCode: 'GBP', customer: { emailAddress: 'buyer@example.com' } };
        const payment: any = { amount: 12999, metadata: { public: details } };
        setBankEmailRuntime({ enabled: () => true, hasPremiumAccess: () => false, send, storeName: () => '' });
        expect(await sub.handle('reminder', order, payment, new Date())).toBe(false);
        setBankEmailRuntime({ enabled: () => false, hasPremiumAccess: () => true });
        expect(await sub.handle('reminder', order, payment, new Date())).toBe(false);
        setBankEmailRuntime({ enabled: () => true, hasPremiumAccess: () => true });
        expect(await sub.handle('reminder', order, payment, new Date())).toBe(true);
        expect(send).toHaveBeenCalledWith('buyer@example.com', expect.objectContaining({ subject: 'Reminder: your bank transfer for order ORD1' }));
    });

    it('never throws when sending fails', async () => {
        setBankEmailRuntime({ enabled: () => true, hasPremiumAccess: () => true, send: async () => { throw new Error('smtp down'); } });
        const sub = new BankTransferEmailSubscriber({} as any, {} as any);
        expect(await sub.handle('expired', { id: 1, code: 'X', customer: { emailAddress: 'a@b.co' } } as any, { metadata: {} } as any, new Date())).toBe(false);
    });
});
