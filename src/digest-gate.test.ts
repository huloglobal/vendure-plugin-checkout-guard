import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckoutGuardService } from './checkout-guard.service';

/** Weekly report + setup checklist are premium since 0.4.0. */
describe('weekly report is premium', () => {
    afterEach(() => vi.useRealTimers());

    function service(premium: () => boolean) {
        const svc = new CheckoutGuardService({ rawConnection: {} } as any, {} as any, {} as any);
        (svc as any).hooks = { hasPremiumAccess: premium, getOptions: () => ({}), getLicenceStatus: () => null, getEvalState: () => null };
        return svc;
    }

    it('ticks only while premium is active; lapsing stops it, renewing resumes it', async () => {
        vi.useFakeTimers();
        let premium = false;
        const svc = service(() => premium);
        const digest = { tick: vi.fn(async () => true) } as any;
        svc.startDigestLoop(digest, 5 * 60_000);
        await vi.advanceTimersByTimeAsync(90_000 + 10 * 60_000);
        expect(digest.tick).not.toHaveBeenCalled();
        premium = true;
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(digest.tick).toHaveBeenCalledTimes(1);
        premium = false;
        await vi.advanceTimersByTimeAsync(15 * 60_000);
        expect(digest.tick).toHaveBeenCalledTimes(1);
        svc.stopDigestLoop();
    });

    it('settings say nothing is due without premium', async () => {
        const svc = service(() => false);
        (svc as any).digestInternal = { settings: async () => ({ enabled: true, recipient: null, defaultRecipient: 'a@b.co', lastSentAt: null, nextDueAt: '2026-11-16T08:00:00.000Z' }) };
        expect(await svc.digestSettings()).toMatchObject({ enabled: true, nextDueAt: null, premium: false });
        const paid = service(() => true);
        (paid as any).digestInternal = (svc as any).digestInternal;
        expect(await paid.digestSettings()).toMatchObject({ nextDueAt: '2026-11-16T08:00:00.000Z', premium: true });
    });
});
