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
        expect(m.html).toContain('<strong>12345678</strong>');
    });

    it('composes the expiry notice and escapes HTML', () => {
        const m = composeBankEmail('expired', { orderCode: 'O<1>', payBy: new Date('2026-11-20T00:00:00Z'), details: null, amountMinor: 500, currency: 'EUR' });
        expect(m.subject).toBe('Your order O<1> has been cancelled');
        expect(m.html).toContain('O&lt;1&gt;');
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
