import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Ctx, Permission, RequestContext } from '@vendure/core';

import { BankTransferListStatus, BankTransferService } from './bank-transfer.service';
import { getBankTransferRuntime } from './bank-transfer-runtime';
import { isAdminApiSession } from '@huloglobal/vendure-licence-sdk';

/** Order-level permissions: reads need ReadOrder, actions need UpdateOrder. */
function denyUnlessAdmin(ctx: RequestContext, res: Response, write: boolean): boolean {
    const needed = write ? [Permission.UpdateOrder] : [Permission.ReadOrder];
    if (!isAdminApiSession(ctx) || !ctx.userHasPermissions(needed)) {
        res.status(403).json({ error: 'forbidden' });
        return true;
    }
    return false;
}

const STATUSES: BankTransferListStatus[] = ['awaiting', 'expired', 'settled', 'cancelled', 'all'];

/**
 * Admin surface for bank transfers under the plugin's shared `/checkout-guard`
 * prefix (Nest merges controllers with the same prefix).
 *
 *   GET  /checkout-guard/bank-transfers?status=awaiting|expired|settled|cancelled|all&days=90&limit=200
 *   POST /checkout-guard/bank-transfers/:paymentId/received   → settle (order → PaymentSettled)
 *   POST /checkout-guard/bank-transfers/:paymentId/cancel     → cancel payment + order  { reason?: string }
 */
@Controller('checkout-guard')
export class BankTransferController {
    constructor(private service: BankTransferService) {}

    @Get('bank-transfers')
    async list(
        @Ctx() ctx: RequestContext, @Res() res: Response,
        @Query('status') status?: string, @Query('days') days?: string, @Query('limit') limit?: string,
    ) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const st = STATUSES.includes(status as BankTransferListStatus) ? (status as BankTransferListStatus) : 'awaiting';
        const rows = await this.service.list(st, Number(days) || 90, Number(limit) || 200, ctx);
        const runtime = getBankTransferRuntime();
        return res.status(200).json({
            status: st,
            premium: runtime.hasPremiumAccess(),
            expiryDays: runtime.expiryDays,
            reminderAfterDays: runtime.reminderAfterDays,
            rows,
        });
    }

    @Post('bank-transfers/:paymentId/received')
    async received(@Ctx() ctx: RequestContext, @Res() res: Response, @Param('paymentId') paymentId: string) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        if (!/^\d{1,18}$/.test(paymentId)) return res.status(400).json({ ok: false, error: 'bad_payment_id' });
        const result = await this.service.markReceived(paymentId, ctx);
        return res.status(result.ok ? 200 : 409).json(result);
    }

    @Post('bank-transfers/:paymentId/cancel')
    async cancel(
        @Ctx() ctx: RequestContext, @Res() res: Response,
        @Param('paymentId') paymentId: string, @Body() body?: { reason?: string },
    ) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        if (!/^\d{1,18}$/.test(paymentId)) return res.status(400).json({ ok: false, error: 'bad_payment_id' });
        const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : undefined;
        const result = await this.service.cancelByAdmin(paymentId, reason || undefined, ctx);
        return res.status(result.ok ? 200 : 409).json(result);
    }
}
