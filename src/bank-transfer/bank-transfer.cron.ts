import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Logger, ProcessContext } from '@vendure/core';

import { BankTransferService } from './bank-transfer.service';

const loggerCtx = 'CheckoutGuard';

/**
 * Six-hourly sweep of unpaid bank transfers (worker process only). No Redis
 * lock: the worker is a single process on the supported deployments and every
 * step re-reads the payment state before acting, so a rare double run is
 * harmless (the second sees Cancelled and skips).
 */
@Injectable()
export class BankTransferCrons {
    constructor(
        private service: BankTransferService,
        private processContext: ProcessContext,
    ) {}

    @Cron(CronExpression.EVERY_6_HOURS)
    async sweepBankTransfers() {
        if (this.processContext.isServer) return; // worker only
        try {
            const r = await this.service.sweep();
            if (r.skipped) return;
            if (r.scanned > 0 || r.expired > 0 || r.reminded > 0) {
                Logger.info(
                    `Bank transfer sweep: ${r.scanned} awaiting, ${r.expired} expired, ${r.reminded} reminder(s) published`,
                    loggerCtx,
                );
            }
        } catch (e: any) {
            Logger.error(`Bank transfer sweep failed: ${e.message}`, loggerCtx);
        }
    }

    /**
     * Stripe bank transfers (`bankTransfer.stripe`, worker only): settles any
     * transfer whose PaymentIntent Stripe reports as paid, in case the webhook
     * was missed. A no-op while the mode is off. At 5, 15 … 55 minutes past the
     * hour, and a run starts no new check after three minutes, so it never
     * holds their shared lock when the six-hourly sweep starts.
     */
    @Cron('0 5-59/10 * * * *')
    async syncStripeBankTransfers() {
        if (this.processContext.isServer) return; // worker only
        try {
            const r = await this.service.syncStripe();
            if (r.settled > 0) {
                Logger.info(`Stripe bank transfers: ${r.settled} settled from Stripe (${r.checked} checked, ${r.awaiting} still awaiting funds)`, loggerCtx);
            }
        } catch (e: any) {
            Logger.error(`Stripe bank-transfer check failed: ${e?.message || e}`, loggerCtx);
        }
    }
}
