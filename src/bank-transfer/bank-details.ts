import { DEFAULT_BANK_TRANSFER_EXPIRY_DAYS } from './bank-transfer-runtime';

export const BANK_TRANSFER_HANDLER_CODE = 'bank-transfer';

/**
 * The `public` slice of a bank-transfer payment's metadata. Vendure exposes
 * only `metadata.public` through the Shop API, so this is exactly what the
 * storefront reads from `activeOrder.payments[].metadata.public` (and again
 * from `orderByCode` on the confirmation page while the order is in
 * `PaymentAuthorized`).
 */
export interface BankTransferPublicDetails {
    /** Constant marker so storefronts can branch without inspecting the method code. */
    method: 'bank-transfer';
    /** `'stripe'` when the account is the customer's Stripe virtual account
     *  (`bankTransfer.stripe`); absent for the payment method's own details. */
    provider?: 'stripe';
    accountName?: string;
    accountNumber?: string;
    /** Formatted `12-34-56` for Stripe accounts; as entered for the payment method's own details. */
    sortCode?: string;
    iban?: string;
    bic?: string;
    /** What the customer must quote as the payment reference: the order code,
     *  or Stripe's reference when `provider` is `'stripe'`. */
    reference: string;
    /** Amount due in minor units (pence / cents). For Stripe, what is still to pay. */
    amountMinor: number;
    /** ISO 4217 code, e.g. GBP. */
    currency: string;
    /** ISO timestamp after which the order is expired by the sweep (premium) or should be chased. */
    payBy: string;
    /** Number of days the customer was given, for display ("pay within 7 days"). */
    expiryDays: number;
    instructions?: string;
    /** Stripe's hosted page with the same instructions (Stripe accounts only). */
    hostedInstructionsUrl?: string;
}

export interface BankDetailsArgs {
    accountName?: string | null;
    accountNumber?: string | null;
    sortCode?: string | null;
    iban?: string | null;
    bic?: string | null;
    instructions?: string | null;
    expiryDays?: number | null;
}

/** Trim a handler arg and drop it when empty so the storefront never renders blank rows. */
function cleanArg(value: string | null | undefined): string | undefined {
    const v = (value ?? '').trim();
    return v.length ? v : undefined;
}

/** Handler-arg expiryDays is an int arg; guard against 0 / negative / NaN from a mis-set method. */
export function normaliseExpiryDays(value: number | string | null | undefined): number {
    const n = Number(value);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_BANK_TRANSFER_EXPIRY_DAYS;
}

/**
 * The pay-by moment: `expiryDays` after `from`, at the end of that day in
 * UTC, so "pay within 7 days" always means seven full calendar days rather
 * than an odd time-of-day cut-off that depends on when the customer checked out.
 */
export function computePayBy(from: Date, expiryDays: number): Date {
    const days = normaliseExpiryDays(expiryDays);
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + days, 23, 59, 59, 999));
    return d;
}

export function buildBankTransferPublicDetails(input: {
    orderCode: string;
    amountMinor: number;
    currency: string;
    args: BankDetailsArgs;
    now?: Date;
}): BankTransferPublicDetails {
    const now = input.now ?? new Date();
    const expiryDays = normaliseExpiryDays(input.args.expiryDays);
    const details: BankTransferPublicDetails = {
        method: BANK_TRANSFER_HANDLER_CODE,
        reference: input.orderCode,
        amountMinor: Math.round(Number(input.amountMinor) || 0),
        currency: input.currency,
        payBy: computePayBy(now, expiryDays).toISOString(),
        expiryDays,
    };
    const accountName = cleanArg(input.args.accountName);
    const accountNumber = cleanArg(input.args.accountNumber);
    const sortCode = cleanArg(input.args.sortCode);
    const iban = cleanArg(input.args.iban);
    const bic = cleanArg(input.args.bic);
    const instructions = cleanArg(input.args.instructions);
    if (accountName) details.accountName = accountName;
    if (accountNumber) details.accountNumber = accountNumber;
    if (sortCode) details.sortCode = sortCode;
    if (iban) details.iban = iban;
    if (bic) details.bic = bic;
    if (instructions) details.instructions = instructions;
    return details;
}

/**
 * Read the public details back out of a stored payment's metadata. Tolerates
 * the metadata arriving as a JSON string (raw SQL) or an object (entity), and
 * returns null for payments that are not bank transfers.
 */
export function readBankTransferPublicDetails(metadata: unknown): BankTransferPublicDetails | null {
    let meta: any = metadata;
    if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { return null; }
    }
    const pub = meta && typeof meta === 'object' ? meta.public : null;
    if (!pub || typeof pub !== 'object') return null;
    if (pub.method !== BANK_TRANSFER_HANDLER_CODE) return null;
    return pub as BankTransferPublicDetails;
}

/** Parse the ISO payBy string; null when absent or unparseable. */
export function parsePayBy(details: BankTransferPublicDetails | null | undefined): Date | null {
    if (!details?.payBy) return null;
    const d = new Date(details.payBy);
    return Number.isNaN(d.getTime()) ? null : d;
}
