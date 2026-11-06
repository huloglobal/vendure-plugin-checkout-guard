import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nodemailerMock = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock('nodemailer', () => ({ ...nodemailerMock, default: nodemailerMock }));
const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('@vendure/core', () => ({ Logger: log }));

import { formatMinor, OpsAlertService } from './ops-alert.service';
import { configureObservability } from './runtime';

describe('formatMinor', () => {
    it('formats known currencies', () => {
        expect(formatMinor(12999, 'GBP')).toBe('£129.99');
        expect(formatMinor(-2999, 'GBP')).toBe('-£29.99');
        expect(formatMinor(500, 'EUR')).toBe('€5.00');
    });
    it('never invents a currency', () => {
        expect(formatMinor(12999)).toBe('129.99');
        expect(formatMinor(12999, null)).toBe('129.99');
        expect(formatMinor(100, 'NOPE')).toBe('1.00 NOPE');
    });
});

describe('ops e-mail transport', () => {
    const SMTP_KEYS = ['SMTP_SERVER', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'];
    const saved = Object.fromEntries(SMTP_KEYS.map(k => [k, process.env[k]]));
    const event = { event: 'payment.failed', text: 'Payment failed for ORD1', orderCode: 'ORD1' };
    let hosts = 0;

    /** A new SMTP host each time, so every test builds its own pooled transport. */
    function useSmtp(port: number): void {
        process.env.SMTP_SERVER = `smtp${++hosts}.example.test`;
        process.env.SMTP_PORT = String(port);
        process.env.SMTP_USER = 'ops@example.test';
        process.env.SMTP_PASSWORD = 'not-a-secret';
        delete process.env.SMTP_FROM;
    }
    /** The next transport nodemailer hands out. */
    function nextTransport(sendMail: () => Promise<unknown>) {
        const t = { sendMail: vi.fn(sendMail), close: vi.fn() };
        nodemailerMock.createTransport.mockReturnValueOnce(t);
        return t;
    }
    /** Let the service's `import('nodemailer')` settle without moving the fake clock. */
    async function until(done: () => boolean): Promise<void> {
        for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setImmediate(r));
    }

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        nodemailerMock.createTransport.mockReset();
        log.warn.mockClear();
        configureObservability({ getOptions: () => ({ ops: { adminEmail: 'owner@example.test' } }), hasPremiumAccess: () => true });
    });
    afterEach(() => {
        vi.useRealTimers();
        configureObservability({ getOptions: () => ({}), hasPremiumAccess: () => false });
        for (const k of SMTP_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    it('allows 30 s to connect, 30 s for the greeting and 45 s of socket idle (port 587: STARTTLS)', async () => {
        useSmtp(587);
        const t = nextTransport(async () => ({}));
        await new OpsAlertService().alert(event);
        expect(nodemailerMock.createTransport).toHaveBeenCalledTimes(1);
        expect(nodemailerMock.createTransport).toHaveBeenCalledWith(expect.objectContaining({
            port: 587, secure: false, connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 45_000,
        }));
        // The socket idle timer runs during the greeting wait. If it is not longer, a server
        // that never greets fails with a bare "Timeout" instead of "Greeting never received".
        const opts = nodemailerMock.createTransport.mock.calls[0][0];
        expect(opts.socketTimeout).toBeGreaterThan(opts.greetingTimeout);
        expect(t.sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'ops@example.test', to: 'owner@example.test' }));
        expect(log.warn).not.toHaveBeenCalled();
    });

    it('uses implicit TLS on port 465', async () => {
        useSmtp(465);
        nextTransport(async () => ({}));
        await new OpsAlertService().sendMail('owner@example.test', { subject: 'Weekly report', text: 'Report' });
        expect(nodemailerMock.createTransport).toHaveBeenCalledWith(expect.objectContaining({
            port: 465, secure: true, connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 45_000,
        }));
    });

    it('gives a send 60 s, then fails it and reconnects for the next one', async () => {
        useSmtp(587);
        const stuck = nextTransport(() => new Promise(() => undefined));
        const svc = new OpsAlertService();
        const outcome = svc.sendMail('owner@example.test', { subject: 'Weekly report', text: 'Report' })
            .then(() => 'sent', (e: Error) => e.message);
        await until(() => stuck.sendMail.mock.calls.length > 0);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(await Promise.race([outcome, Promise.resolve('pending')])).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        expect(await outcome).toBe('smtp timeout (60 s)');
        expect(stuck.close).toHaveBeenCalled();

        const fresh = nextTransport(async () => ({}));
        await svc.sendMail('owner@example.test', { subject: 'Weekly report', text: 'Report' });
        expect(nodemailerMock.createTransport).toHaveBeenCalledTimes(2);
        expect(fresh.sendMail).toHaveBeenCalled();
    });

    it('gives an alert e-mail 60 s too, then logs the failure instead of throwing', async () => {
        useSmtp(587);
        const stuck = nextTransport(() => new Promise(() => undefined));
        let settled = false;
        const alert = new OpsAlertService().alert(event).then(() => { settled = true; });
        await until(() => stuck.sendMail.mock.calls.length > 0);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await alert;
        expect(log.warn).toHaveBeenCalledWith('Ops e-mail failed: smtp timeout (60 s)', 'CheckoutGuard');
        expect(stuck.close).toHaveBeenCalled();
    });
});
