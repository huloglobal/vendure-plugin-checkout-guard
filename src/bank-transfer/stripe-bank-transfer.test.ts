import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@vendure/core';

import { flushAsync, installFakeStripe, stripeBankTransferIntent } from '../__tests__/fakes';
import { StripeRequestError, stripeRequest } from '../stripe-hold/stripe-api';
import {
    StripeBankTransferError, StripeBankTransferInput, _resetStripeBankTransferWarnings, bankTransferCustomerIdempotencyKey,
    bankTransferIdempotencyKey, cancelStripeBankTransfer, createStripeBankTransfer, describeStripeFailure, findStrayBankTransferIntents,
    formatSortCode, isStripeTransferKnownSucceeded, noteStripeTransferSucceeded, normaliseStripeBankTransferOptions,
    parseBankTransferStripeMetadata, retrieveCustomerCashBalance, settledThroughStripe, stripeChannelIdOf, stripeCustomerIdOf,
    stripePaymentIntentIdOf, stripeTransferFunding,
} from './stripe-bank-transfer';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const settings = normaliseStripeBankTransferOptions({ enabled: true })!;

/** A guest checkout (nobody signed in) unless `ownerUserId` is given. */
function input(over: Partial<StripeBankTransferInput> = {}): StripeBankTransferInput {
    return {
        orderCode: 'ORD1', orderId: 10, channelId: 2, amountMinor: 12999, currency: 'GBP',
        customer: { id: 7, emailAddress: 'jane@example.com', firstName: 'Jane', lastName: 'Doe' },
        expiryDays: 7, settings, now: NOW, ...over,
    };
}
const signedIn = (over: Partial<StripeBankTransferInput['customer']> = {}) =>
    ({ id: 7, emailAddress: 'jane@example.com', firstName: 'Jane', lastName: 'Doe', ownerUserId: 12, ...over });
/** The Stripe customer this plugin created for Vendure customer 7 / user 12. */
const boundCustomer = { id: 'cus_bound', email: 'jane@example.com', metadata: { cg_vendure_customer_id: '7', cg_vendure_user_id: '12' } };

let stripe: ReturnType<typeof installFakeStripe>;

beforeEach(() => {
    _resetStripeBankTransferWarnings();
    stripe = installFakeStripe(call => {
        if (call.method === 'GET' && call.path === '/v1/customers') return { body: { object: 'list', data: [] } };
        if (call.method === 'POST' && call.path === '/v1/customers') return { body: { id: 'cus_new', email: call.form.email } };
        if (call.method === 'POST' && call.path === '/v1/payment_intents') return { body: stripeBankTransferIntent({ customer: call.form.customer }) };
        if (call.method === 'POST' && call.path.endsWith('/cancel')) return { body: { id: 'pi_bt123', status: 'canceled' } };
        return { status: 404, body: { error: { message: 'no route' } } };
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('normaliseStripeBankTransferOptions', () => {
    it('is off unless explicitly enabled, and defaults to GBP only', () => {
        expect(normaliseStripeBankTransferOptions(undefined)).toBeNull();
        expect(normaliseStripeBankTransferOptions({})).toBeNull();
        expect(normaliseStripeBankTransferOptions({ enabled: false, currencies: ['GBP'] })).toBeNull();
        expect(normaliseStripeBankTransferOptions({ enabled: true })).toEqual({ currencies: ['GBP'], euCountry: null, instructions: null });
        expect(normaliseStripeBankTransferOptions({ enabled: true, currencies: [] })!.currencies).toEqual(['GBP']);
    });

    it('drops currencies it cannot serve, with one warning each', () => {
        const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
        expect(normaliseStripeBankTransferOptions({ enabled: true, currencies: ['gbp', 'EUR', 'USD', 'GBP'] })!.currencies).toEqual(['GBP']);
        expect(warn.mock.calls.map(c => c[0])).toEqual([
            expect.stringContaining('EUR needs bankTransfer.stripe.euCountry'),
            expect.stringContaining('USD is not supported'),
        ]);
        normaliseStripeBankTransferOptions({ enabled: true, currencies: ['USD'] });
        expect(warn).toHaveBeenCalledTimes(2); // not repeated
    });

    it('serves EUR with a valid IBAN country (not Spain, where Stripe issues no new ones), and keeps a custom instructions text', () => {
        const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
        expect(normaliseStripeBankTransferOptions({ enabled: true, currencies: ['GBP', 'eur'], euCountry: ' ie ', instructions: '  Quote {reference}.  ' }))
            .toEqual({ currencies: ['GBP', 'EUR'], euCountry: 'IE', instructions: 'Quote {reference}.' });
        expect(normaliseStripeBankTransferOptions({ enabled: true, currencies: ['EUR'], euCountry: 'GB' }))
            .toEqual({ currencies: [], euCountry: null, instructions: null });
        expect(normaliseStripeBankTransferOptions({ enabled: true, currencies: ['GBP', 'EUR'], euCountry: 'ES' }))
            .toEqual({ currencies: ['GBP'], euCountry: null, instructions: null });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"ES" is not a country Stripe issues new IBANs in (BE, DE, FR, IE, NL)'), 'CheckoutGuard');
    });
});

describe('formatSortCode / idempotency keys', () => {
    it('formats six digits as 12-34-56 and leaves anything else as Stripe sent it', () => {
        expect(formatSortCode('200000')).toBe('20-00-00');
        expect(formatSortCode('12-34-56')).toBe('12-34-56');
        expect(formatSortCode(' 12 34 56 ')).toBe('12-34-56');
        expect(formatSortCode('12345')).toBe('12345');
        expect(formatSortCode(undefined)).toBe('');
    });

    it('derives the PaymentIntent key from the order code and amount, and the customer key from the order and the exact request', () => {
        expect(bankTransferIdempotencyKey('ORD1', 12999)).toBe('cg-bt-ORD1-12999');
        const a = bankTransferCustomerIdempotencyKey('ORD1', { email: 'jane@example.com', name: 'Jane Doe' });
        expect(a).toMatch(/^cg-bt-customer-ORD1-[0-9a-f]{16}$/);
        expect(bankTransferCustomerIdempotencyKey('ORD1', { email: 'jane@example.com', name: 'Jane Doe' })).toBe(a);
        expect(bankTransferCustomerIdempotencyKey('ORD1', { email: 'jane@example.org', name: 'Jane Doe' })).not.toBe(a);
        expect(a).not.toContain('jane'); // no personal data in the key
    });
});

describe('createStripeBankTransfer — requests', () => {
    it('a guest checkout gets a Stripe customer of its own (no lookup by e-mail), then the confirmed PaymentIntent', async () => {
        const out = await createStripeBankTransfer('sk_test_bt', input());
        expect(stripe.calls.map(c => `${c.method} ${c.path}`)).toEqual(['POST /v1/customers', 'POST /v1/payment_intents']);
        for (const c of stripe.calls) {
            expect(c.headers.Authorization).toBe('Bearer sk_test_bt');
            expect(c.headers['Stripe-Version']).toBe('2022-11-15');
            expect(c.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        }
        const [customer, intent] = stripe.calls;
        expect(customer.form).toEqual({
            email: 'jane@example.com', name: 'Jane Doe', 'metadata[cg_vendure_customer_id]': '7', 'metadata[cg_order_code]': 'ORD1',
        });
        expect(customer.headers['Idempotency-Key']).toBe(bankTransferCustomerIdempotencyKey('ORD1', {
            email: 'jane@example.com', name: 'Jane Doe', metadata: { cg_vendure_customer_id: '7', cg_order_code: 'ORD1' },
        }));
        expect(intent.headers['Idempotency-Key']).toBe('cg-bt-ORD1-12999');
        expect(intent.form).toEqual({
            amount: '12999',
            currency: 'gbp',
            customer: 'cus_new',
            'payment_method_types[0]': 'customer_balance',
            'payment_method_data[type]': 'customer_balance',
            'payment_method_options[customer_balance][funding_type]': 'bank_transfer',
            'payment_method_options[customer_balance][bank_transfer][type]': 'gb_bank_transfer',
            confirm: 'true',
            description: 'Order ORD1 (bank transfer)',
            'metadata[cg_bank_transfer]': '1',
            'metadata[cg_order_code]': 'ORD1',
            'metadata[cg_order_id]': '10',
            'metadata[cg_channel_id]': '2',
        });
        // Strictly form-encoded (brackets escaped), and none of Vendure's StripePlugin metadata keys.
        expect(intent.body).toContain('payment_method_types%5B0%5D=customer_balance');
        expect(intent.body).toContain('payment_method_options%5Bcustomer_balance%5D%5Bbank_transfer%5D%5Btype%5D=gb_bank_transfer');
        expect(intent.body).not.toMatch(/metadata%5B(channelToken|orderId|orderCode|languageCode)%5D/);
        expect(out).toMatchObject({ kind: 'awaiting', paymentIntentId: 'pi_bt123', customerId: 'cus_new', reusedCustomer: false, status: 'requires_action' });
    });

    it('never reuses a customer for a guest, even one with the same e-mail and a balance', async () => {
        stripe.respond(call => {
            if (call.method === 'GET' && call.path === '/v1/customers') return { body: { data: [boundCustomer] } };
            if (call.path === '/v1/customers') return { body: { id: 'cus_fresh' } };
            return { body: stripeBankTransferIntent({ customer: call.form.customer }) };
        });
        const out = await createStripeBankTransfer('sk_test_bt', input({ customer: { ...signedIn(), ownerUserId: null } }));
        expect(stripe.to(/^GET \/v1\/customers/)).toHaveLength(0);
        expect(stripe.to(/payment_intents/)[0].form.customer).toBe('cus_fresh');
        expect(out.reusedCustomer).toBe(false);
    });

    it('a signed-in customer reuses only the Stripe customer bound to them (customer and user id), never one someone else made', async () => {
        stripe.respond(call => {
            if (call.method === 'GET' && call.path === '/v1/customers') {
                return {
                    body: {
                        data: [
                            { id: 'cus_plugin', email: 'jane@example.com', metadata: {} },                                                     // Vendure StripePlugin
                            { id: 'cus_guest', email: 'jane@example.com', metadata: { cg_vendure_customer_id: '7', cg_order_code: 'ORD0' } },   // an earlier guest checkout
                            { id: 'cus_other', email: 'jane@example.com', metadata: { cg_vendure_customer_id: '7', cg_vendure_user_id: '99' } },
                            boundCustomer,
                        ],
                    },
                };
            }
            return { body: stripeBankTransferIntent({ customer: call.form.customer }) };
        });
        const out = await createStripeBankTransfer('sk_test_bt', input({ customer: signedIn() }));
        const [lookup] = stripe.calls;
        expect(`${lookup.method} ${lookup.path}`).toBe('GET /v1/customers');
        expect(lookup.query).toEqual({ email: 'jane@example.com', limit: '100' });
        expect(lookup.headers['Idempotency-Key']).toBeUndefined();
        expect(stripe.to(/^POST \/v1\/customers$/)).toHaveLength(0);
        expect(stripe.to(/payment_intents/)[0].form.customer).toBe('cus_bound');
        expect(out).toMatchObject({ customerId: 'cus_bound', reusedCustomer: true });
    });

    it('creates a bound customer the first time a signed-in customer pays by transfer', async () => {
        stripe.respond(call => {
            if (call.method === 'GET' && call.path === '/v1/customers') return { body: { data: [{ id: 'cus_plugin', metadata: {} }] } };
            if (call.path === '/v1/customers') return { body: { id: 'cus_newbound' } };
            return { body: stripeBankTransferIntent({ customer: call.form.customer }) };
        });
        await createStripeBankTransfer('sk_test_bt', input({ customer: signedIn() }));
        expect(stripe.to(/^POST \/v1\/customers$/)[0].form).toEqual({
            email: 'jane@example.com', name: 'Jane Doe', 'metadata[cg_vendure_customer_id]': '7', 'metadata[cg_vendure_user_id]': '12',
        });
        expect(stripe.to(/payment_intents/)[0].form.customer).toBe('cus_newbound');
    });

    it('omits an empty name, and keeps the order code on a customer without a Vendure id', async () => {
        await createStripeBankTransfer('sk_test_bt', input({ customer: { emailAddress: 'a@b.c', firstName: ' ', lastName: null } }));
        expect(stripe.to(/^POST \/v1\/customers$/)[0].form).toEqual({ email: 'a@b.c', 'metadata[cg_order_code]': 'ORD1' });
    });

    it('asks for an IBAN in the configured country for EUR', async () => {
        vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
        const eur = normaliseStripeBankTransferOptions({ enabled: true, currencies: ['GBP', 'EUR'], euCountry: 'NL' })!;
        stripe.respond(call => {
            if (call.path === '/v1/customers') return { body: { id: 'cus_1' } };
            return {
                body: stripeBankTransferIntent({
                    currency: 'eur',
                    instructions: {
                        type: 'eu_bank_transfer', reference: 'EUREF1',
                        financial_addresses: [{ type: 'iban', iban: { account_holder_name: 'HULO GLOBAL LIMITED', iban: 'NL40CITI7000799556', bic: 'CITINL2XXXX', country: 'NL' } }],
                    },
                }),
            };
        });
        const out = await createStripeBankTransfer('sk_test_bt', input({ currency: 'EUR', settings: eur }));
        const form = stripe.to(/payment_intents/)[0].form;
        expect(form['payment_method_options[customer_balance][bank_transfer][type]']).toBe('eu_bank_transfer');
        expect(form['payment_method_options[customer_balance][bank_transfer][eu_bank_transfer][country]']).toBe('NL');
        expect(form.currency).toBe('eur');
        expect(out.details).toMatchObject({ provider: 'stripe', accountName: 'HULO GLOBAL LIMITED', iban: 'NL40CITI7000799556', bic: 'CITINL2XXXX', reference: 'EUREF1', currency: 'EUR' });
        expect(out.details.instructions).toContain('SEPA');
        expect('sortCode' in out.details).toBe(false);
    });
});

describe('createStripeBankTransfer — details', () => {
    it('maps Stripe\'s instructions onto the public fields the storefront and e-mails render', async () => {
        const { details } = await createStripeBankTransfer('sk_test_bt', input());
        expect(details).toEqual({
            method: 'bank-transfer',
            provider: 'stripe',
            accountName: 'HULO GLOBAL LIMITED',
            sortCode: '20-00-00',
            accountNumber: '98765432',
            reference: 'RF7K2M9Q4XWZ',
            amountMinor: 12999,
            currency: 'GBP',
            payBy: '2026-11-13T23:59:59.999Z',
            expiryDays: 7,
            instructions: 'Please send the exact amount and quote the reference RF7K2M9Q4XWZ so we can match your payment to this order. '
                + 'Faster Payments usually arrive within hours; BACS can take up to three working days.',
            hostedInstructionsUrl: 'https://payments.stripe.com/bank_transfers/instructions/test_abc',
        });
        expect(JSON.stringify(details)).not.toContain('pi_bt123'); // the intent id is never public
    });

    it('uses the custom instructions text, and drops a hosted URL that is not https', async () => {
        const custom = normaliseStripeBankTransferOptions({ enabled: true, instructions: 'Use {reference} as the reference. Thank you.' })!;
        stripe.respond(call => call.path === '/v1/customers'
            ? { body: { id: 'cus_1' } }
            : { body: stripeBankTransferIntent({ instructions: { hosted_instructions_url: 'http://example.com/x' } }) });
        const { details } = await createStripeBankTransfer('sk_test_bt', input({ settings: custom }));
        expect(details.instructions).toBe('Use RF7K2M9Q4XWZ as the reference. Thank you.');
        expect(details.hostedInstructionsUrl).toBeUndefined();
    });
});

describe('createStripeBankTransfer — cash balances', () => {
    const ownerStripe = (intent: Record<string, any>) => stripe.respond(call => {
        if (call.method === 'GET' && call.path === '/v1/customers') return { body: { data: [boundCustomer] } };
        if (call.path.endsWith('/cancel')) return { body: { id: 'pi_bt123', status: 'canceled' } };
        return { body: stripeBankTransferIntent(intent) };
    });

    it('a signed-in customer\'s own balance that covers part of the order: only the rest is asked for', async () => {
        ownerStripe({ instructions: { amount_remaining: 2999 } });
        const out = await createStripeBankTransfer('sk_test_bt', input({ customer: signedIn() }));
        expect(out.kind).toBe('awaiting');
        expect(out.details.amountMinor).toBe(2999);
    });

    it('a signed-in customer\'s own balance that covers the order: paid at once', async () => {
        ownerStripe({ status: 'succeeded', amount_received: 12999, next_action: null });
        const out = await createStripeBankTransfer('sk_test_bt', input({ customer: signedIn() }));
        expect(out.kind).toBe('paid');
        expect(out.details).toMatchObject({ provider: 'stripe', amountMinor: 0, reference: 'ORD1' });
    });

    it('a guest checkout is never paid from a balance: a part-applied intent is cancelled, a paid one reported', async () => {
        stripe.respond(call => {
            if (call.path === '/v1/customers') return { body: { id: 'cus_x' } };
            if (call.path.endsWith('/cancel')) return { body: { id: 'pi_bt123', status: 'canceled' } };
            return { body: stripeBankTransferIntent({ instructions: { amount_remaining: 2999 } }) };
        });
        const part = await createStripeBankTransfer('sk_test_bt', input()).catch(e => e);
        expect(part).toBeInstanceOf(StripeBankTransferError);
        expect(part).toMatchObject({ reason: 'balance_applied', paymentIntentId: 'pi_bt123', intentStatus: 'requires_action' });
        await flushAsync();
        expect(stripe.to(/cancel$/)).toHaveLength(1);

        stripe.respond(call => call.path === '/v1/customers'
            ? { body: { id: 'cus_x' } }
            : { body: stripeBankTransferIntent({ status: 'succeeded', amount_received: 12999, next_action: null }) });
        const paid = await createStripeBankTransfer('sk_test_bt', input()).catch(e => e);
        expect(paid).toMatchObject({ reason: 'balance_applied', intentStatus: 'succeeded' });
        await flushAsync();
        expect(stripe.to(/cancel$/)).toHaveLength(1); // a succeeded intent cannot be cancelled
    });
});

describe('createStripeBankTransfer — replayed answers', () => {
    const replay = (live: Record<string, any> | { status: number; body: any }) => stripe.respond(call => {
        if (call.path === '/v1/customers') return { body: { id: 'cus_new' } };
        if (call.method === 'POST' && call.path === '/v1/payment_intents') {
            return { body: stripeBankTransferIntent(), headers: { 'Idempotent-Replayed': 'true' } };
        }
        if (call.method === 'GET' && call.path === '/v1/payment_intents/pi_bt123') return 'status' in live && 'body' in live ? live as any : { body: stripeBankTransferIntent(live) };
        if (call.path.endsWith('/cancel')) return { body: { id: 'pi_bt123', status: 'canceled' } };
        return { status: 404, body: {} };
    });

    it('decides on the live intent when Stripe replays an earlier checkout\'s answer', async () => {
        replay({ instructions: { reference: 'LIVEREF' } });
        const out = await createStripeBankTransfer('sk_test_bt', input());
        expect(stripe.calls.map(c => `${c.method} ${c.path}`)).toEqual(['POST /v1/customers', 'POST /v1/payment_intents', 'GET /v1/payment_intents/pi_bt123']);
        expect(out.details.reference).toBe('LIVEREF');
    });

    it('does not use a replayed intent that has been cancelled since', async () => {
        replay({ status: 'canceled', next_action: null });
        const err = await createStripeBankTransfer('sk_test_bt', input()).catch(e => e);
        expect(err).toMatchObject({ reason: 'unexpected_status', intentStatus: 'canceled' });
        await flushAsync();
        expect(stripe.to(/cancel$/)).toHaveLength(0);
    });

    it('reports the replayed intent as stray when its live state cannot be read', async () => {
        replay({ status: 500, body: { error: { type: 'api_error', message: 'boom' } } });
        const err = await createStripeBankTransfer('sk_test_bt', input()).catch(e => e);
        expect(err).toMatchObject({ reason: 'api_error', stray: { customerId: 'cus_new', orderCode: 'ORD1', paymentIntentId: 'pi_bt123' } });
    });
});

describe('createStripeBankTransfer — failures', () => {
    it('refuses an unsupported currency or a customer without e-mail before calling Stripe', async () => {
        await expect(createStripeBankTransfer('sk_test_bt', input({ currency: 'USD' }))).rejects.toMatchObject({ reason: 'unsupported_currency' });
        await expect(createStripeBankTransfer('sk_test_bt', input({ customer: { emailAddress: '' } }))).rejects.toMatchObject({ reason: 'no_customer' });
        expect(stripe.calls).toHaveLength(0);
    });

    it('surfaces a Stripe API error, which created nothing', async () => {
        stripe.respond(call => call.path === '/v1/customers'
            ? { body: { id: 'cus_1' } }
            : { status: 400, body: { error: { type: 'invalid_request_error', code: 'payment_method_unactivated', message: 'customer_balance is not activated' } } });
        const err = await createStripeBankTransfer('sk_test_bt', input()).catch(e => e);
        expect(err).toBeInstanceOf(StripeRequestError);
        expect(describeStripeFailure(err)).toBe('api_error: payment_method_unactivated: customer_balance is not activated');
    });

    it('gives up when Stripe does not answer within the budget', async () => {
        stripe.respond(() => 'hang');
        const err = await createStripeBankTransfer('sk_test_bt', input(), { timeoutMs: 30 }).catch(e => e);
        expect(describeStripeFailure(err)).toMatch(/^timeout:/);
        expect(stripe.calls).toHaveLength(1);
        expect(err.stray).toBeUndefined(); // only the customer was asked for: no intent can exist
    });

    it('marks a PaymentIntent create whose answer was lost (timeout, 5xx, 409) as possibly stray', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        const cases: Array<[() => any, RegExp]> = [
            [() => 'hang', /^timeout:/],
            [() => ({ status: 500, body: { error: { type: 'api_error', message: 'boom' } } }), /^api_error: .*boom/],
            [() => ({ status: 409, body: { error: { type: 'idempotency_error', message: 'in use' } } }), /^api_error: .*in use/],
        ];
        for (const [reply, msg] of cases) {
            stripe.respond(call => call.path === '/v1/customers' ? { body: { id: 'cus_1' } } : reply());
            const err = await createStripeBankTransfer('sk_test_bt', input(), { timeoutMs: 50 }).catch(e => e);
            expect(err).toBeInstanceOf(StripeBankTransferError);
            expect(describeStripeFailure(err)).toMatch(msg);
            expect(err.stray).toEqual({ customerId: 'cus_1', orderCode: 'ORD1', sinceSec: Math.floor(NOW.getTime() / 1000) - 120 });
        }
    });

    it('treats an intent without usable instructions as a failure and cancels it', async () => {
        const cases: Array<[Record<string, any>, RegExp]> = [
            [{ next_action: null }, /no bank-transfer instructions/],
            [{ instructions: { reference: null } }, /no transfer reference/],
            [{ instructions: { financial_addresses: [{ type: 'iban', iban: { iban: 'X' } }] } }, /no UK sort code/],
            [{ instructions: { financial_addresses: [{ type: 'sort_code', sort_code: { account_holder_name: 'X', sort_code: '200000' } }] } }, /no UK sort code/],
        ];
        for (const [over, msg] of cases) {
            stripe.respond(call => {
                if (call.path === '/v1/customers') return { body: { id: 'cus_1' } };
                if (call.path.endsWith('/cancel')) return { body: { id: 'pi_bt123', status: 'canceled' } };
                return { body: stripeBankTransferIntent(over) };
            });
            const err = await createStripeBankTransfer('sk_test_bt', input()).catch(e => e);
            expect(err).toBeInstanceOf(StripeBankTransferError);
            expect(err.reason).toBe('missing_instructions');
            expect(err.message).toMatch(msg);
        }
        await flushAsync();
        const cancels = stripe.to(/^POST \/v1\/payment_intents\/pi_bt123\/cancel$/);
        expect(cancels).toHaveLength(cases.length);
        expect(cancels[0].form).toEqual({ cancellation_reason: 'abandoned' });
    });

    it('treats any other intent status as a failure', async () => {
        stripe.respond(call => call.path === '/v1/customers'
            ? { body: { id: 'cus_1' } }
            : call.path.endsWith('/cancel') ? { body: {} } : { body: stripeBankTransferIntent({ status: 'requires_payment_method', next_action: null }) });
        await expect(createStripeBankTransfer('sk_test_bt', input())).rejects.toMatchObject({ reason: 'unexpected_status' });
    });
});

describe('metadata helpers', () => {
    it('recognises only the intents this mode created', () => {
        expect(parseBankTransferStripeMetadata({ cg_bank_transfer: '1', cg_order_code: 'ORD1', cg_order_id: '10', cg_channel_id: '2' }))
            .toEqual({ orderCode: 'ORD1', orderId: '10', channelId: '2' });
        expect(parseBankTransferStripeMetadata({ channelToken: 'tok', orderCode: 'ORD1', orderId: '10' })).toBeNull();
        expect(parseBankTransferStripeMetadata({ cg_bank_transfer: '0', cg_order_code: 'ORD1', cg_channel_id: '2' })).toBeNull();
        expect(parseBankTransferStripeMetadata({ cg_bank_transfer: '1', cg_channel_id: '2' })).toBeNull();
        expect(parseBankTransferStripeMetadata(null)).toBeNull();
    });

    it('reads the PaymentIntent, channel and Stripe customer from a payment\'s metadata (object or JSON)', () => {
        const meta = { public: { method: 'bank-transfer' }, paymentIntentId: 'pi_9', stripeChannelId: '2', stripeCustomerId: 'cus_9' };
        expect(stripePaymentIntentIdOf(meta)).toBe('pi_9');
        expect(stripePaymentIntentIdOf(JSON.stringify(meta))).toBe('pi_9');
        expect(stripeChannelIdOf(meta)).toBe('2');
        expect(stripeCustomerIdOf(meta)).toBe('cus_9');
        expect(stripePaymentIntentIdOf({ public: { method: 'bank-transfer' } })).toBeNull();
        expect(stripePaymentIntentIdOf({ paymentIntentId: 'ch_1' })).toBeNull();
        expect(stripePaymentIntentIdOf('not json')).toBeNull();
    });

    it('tells a settlement by Stripe from one by hand', () => {
        expect(settledThroughStripe({ settledBy: 'stripe', stripeStatus: 'succeeded' })).toBe(true);
        expect(settledThroughStripe(JSON.stringify({ stripeStatus: 'succeeded' }))).toBe(true);
        expect(settledThroughStripe({ settledBy: 'hand', stripeStatus: 'canceled' })).toBe(false);
        expect(settledThroughStripe({ stripeStatus: 'requires_action' })).toBe(false);
        expect(settledThroughStripe(null)).toBe(false);
    });

    it('works out partial funding from amount_remaining', () => {
        expect(stripeTransferFunding(stripeBankTransferIntent({ instructions: { amount_remaining: 5000 } })))
            .toEqual({ remaining: 5000, received: 7999, partlyFunded: true });
        expect(stripeTransferFunding(stripeBankTransferIntent()).partlyFunded).toBe(false);
        expect(stripeTransferFunding(stripeBankTransferIntent({ status: 'succeeded', next_action: null }))).toEqual({ remaining: null, received: 0, partlyFunded: false });
    });

    it('remembers for a while which intents were seen to succeed', () => {
        noteStripeTransferSucceeded('pi_seen', 1_000_000);
        expect(isStripeTransferKnownSucceeded('pi_seen', 1_000_000 + 14 * 60_000)).toBe(true);
        expect(isStripeTransferKnownSucceeded('pi_seen', 1_000_000 + 16 * 60_000)).toBe(false);
        expect(isStripeTransferKnownSucceeded('pi_other', 1_000_000)).toBe(false);
    });
});

describe('cancelStripeBankTransfer', () => {
    it('looks at the intent, then cancels it as abandoned with an idempotency key', async () => {
        stripe.respond(call => call.method === 'GET' ? { body: stripeBankTransferIntent() } : { body: { id: 'pi_bt123', status: 'canceled' } });
        expect(await cancelStripeBankTransfer('sk_test_bt', 'pi_bt123')).toEqual({ kind: 'canceled', already: false, received: 0 });
        expect(stripe.calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /v1/payment_intents/pi_bt123', 'POST /v1/payment_intents/pi_bt123/cancel']);
        const cancel = stripe.calls[1];
        expect(cancel.form).toEqual({ cancellation_reason: 'abandoned' });
        expect(cancel.headers['Idempotency-Key']).toMatch(/^cg-cancel-pi_bt123-\d+$/);
    });

    it('reports what had arrived on a part-paid intent (the cancel returns it to the cash balance)', async () => {
        stripe.respond(call => call.method === 'GET'
            ? { body: stripeBankTransferIntent({ instructions: { amount_remaining: 5000 } }) }
            : { body: { id: 'pi_bt123', status: 'canceled' } });
        expect(await cancelStripeBankTransfer('sk_test_bt', 'pi_bt123')).toEqual({ kind: 'canceled', already: false, received: 7999 });
    });

    it('does not cancel an intent that is paid or already cancelled', async () => {
        stripe.respond(() => ({ body: stripeBankTransferIntent({ status: 'succeeded', next_action: null }) }));
        expect(await cancelStripeBankTransfer('sk_test_bt', 'pi_bt123')).toEqual({ kind: 'succeeded' });
        stripe.respond(() => ({ body: stripeBankTransferIntent({ status: 'canceled', next_action: null }) }));
        expect(await cancelStripeBankTransfer('sk_test_bt', 'pi_bt123')).toEqual({ kind: 'canceled', already: true, received: 0 });
        expect(stripe.to(/^POST/)).toHaveLength(0);
    });

    it('tells an intent cancelled meanwhile from one paid meanwhile', async () => {
        const unexpected = { status: 400, body: { error: { code: 'payment_intent_unexpected_state', message: 'This PaymentIntent has a status of canceled.' } } };
        let after = 'canceled';
        stripe.respond(call => {
            if (call.method === 'POST') return unexpected;
            return { body: stripe.to(/^GET/).length > 1 ? { id: 'pi_bt123', status: after } : stripeBankTransferIntent() };
        });
        expect(await cancelStripeBankTransfer('sk_test_bt', 'pi_bt123')).toEqual({ kind: 'canceled', already: true, received: 0 });
        after = 'succeeded';
        stripe.calls.length = 0;
        expect(await cancelStripeBankTransfer('sk_test_bt', 'pi_bt123')).toEqual({ kind: 'succeeded' });
    });

    it('never throws', async () => {
        stripe.respond(() => ({ status: 500, body: { error: { type: 'api_error', message: 'boom' } } }));
        expect(await cancelStripeBankTransfer('sk_test_bt', 'pi_bt123')).toEqual({ kind: 'failed', message: 'api_error: api_error: boom', received: null });
        stripe.respond(() => 'hang');
        expect((await cancelStripeBankTransfer('sk_test_bt', 'pi_bt123', { timeoutMs: 20 })).kind).toBe('failed');
    });
});

describe('stray intents and cash balances', () => {
    it('lists the customer\'s intents since the failed create and keeps the order\'s bank-transfer ones', async () => {
        stripe.respond(() => ({
            body: {
                data: [
                    stripeBankTransferIntent({ id: 'pi_a1' }),
                    stripeBankTransferIntent({ id: 'pi_b2', metadata: { cg_bank_transfer: '1', cg_order_code: 'ORD2', cg_channel_id: '2' } }),
                    { id: 'pi_card', status: 'succeeded', metadata: { orderCode: 'ORD1', channelToken: 'tok', orderId: '10' } },
                ],
            },
        }));
        const found = await findStrayBankTransferIntents('sk_test_bt', { customerId: 'cus_1', orderCode: 'ORD1', sinceSec: 1_790_000_000 });
        expect(found.map(p => p.id)).toEqual(['pi_a1']);
        const [call] = stripe.calls;
        expect(`${call.method} ${call.path}`).toBe('GET /v1/payment_intents');
        expect(call.query).toEqual({ customer: 'cus_1', 'created[gte]': '1790000000', limit: '20' });
    });

    it('reads a customer\'s available cash balance', async () => {
        stripe.respond(() => ({ body: { object: 'cash_balance', available: { gbp: 2500 }, customer: 'cus_1' } }));
        expect(await retrieveCustomerCashBalance('sk_test_bt', 'cus_1')).toEqual({ gbp: 2500 });
        expect(stripe.calls[0].path).toBe('/v1/customers/cus_1/cash_balance');
    });
});

describe('stripeRequest response hook', () => {
    it('reports Stripe\'s Idempotent-Replayed header', async () => {
        const seen: any[] = [];
        stripe.respond(() => ({ body: { id: 'x' }, headers: { 'Idempotent-Replayed': 'true' } }));
        await stripeRequest('sk_test_bt', 'POST', 'v1/payment_intents', {}, { onResponse: r => seen.push(r) });
        stripe.respond(() => ({ body: { id: 'x' } }));
        await stripeRequest('sk_test_bt', 'POST', 'v1/payment_intents', {}, { onResponse: r => seen.push(r) });
        expect(seen).toEqual([{ status: 200, replayed: true }, { status: 200, replayed: false }]);
    });
});
