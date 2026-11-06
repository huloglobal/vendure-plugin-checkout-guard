<p align="center"><a href="https://huloglobal.com/vendure-plugins/checkout-guard/"><img src="https://huloglobal.com/vendure-plugins/logos/checkout-guard.svg?v=2" width="96" height="96" alt="HULO Checkout Guard logo"></a></p>

# @huloglobal/vendure-plugin-checkout-guard

[![npm](https://img.shields.io/npm/v/@huloglobal/vendure-plugin-checkout-guard?label=npm)](https://www.npmjs.com/package/@huloglobal/vendure-plugin-checkout-guard) [![downloads](https://img.shields.io/npm/dm/@huloglobal/vendure-plugin-checkout-guard)](https://www.npmjs.com/package/@huloglobal/vendure-plugin-checkout-guard) ![Vendure](https://img.shields.io/badge/Vendure-3.5%20%E2%80%93%203.7-17b) ![databases](https://img.shields.io/badge/MySQL%20%7C%20MariaDB%20%7C%20PostgreSQL-ok-green) [![licence](https://img.shields.io/badge/licence-AGPL--3.0%20%2B%20commercial-blue)](https://huloglobal.com/vendure-plugins/checkout-guard/)

The safety layer around Vendure checkout and payments. Vendure's Stripe
integration settles a payment when the intent succeeds — and nothing else.
Put a manual-capture hold on a large order and the customer sees a
confirmation page while the order never places and the authorisation
silently expires. Enable bank transfer and there is no expiry, no reminder,
no reconciliation. A card declines and no one ever knows. Checkout Guard
closes those gaps server-side and shows you all of it in one admin page.

**Plugin page & pricing:** https://huloglobal.com/vendure-plugins/checkout-guard/

## Quick start

```bash
yarn add @huloglobal/vendure-plugin-checkout-guard   # or npm install / pnpm add
```

1. Register `CheckoutGuardPlugin.init({ publicBaseUrl })` in `vendure-config.ts` (full options under [Install](#install)).
2. Add `CheckoutGuardPlugin.uiExtensions` to your `compileUiExtensions` call and rebuild the admin UI.
3. Restart Vendure. The tables are created on first boot; there is no migration to run.
4. Open *Sales → Checkout guard* and click **Start 14-day free trial** to switch the premium guards on, or stay on the free tier (see [Tiers](#tiers)).


## What it does

| Module | What you get |
|---|---|
| **Stripe holds** | `stripe-hold` payment handler + signed webhook for `payment_intent.amount_capturable_updated` → an *Authorized* payment, order placed as `PaymentAuthorized`. Capture / cancel from the admin, safety capture before Stripe's 7-day window, `payment_failed` recorded. |
| **Bank transfer** | `bank-transfer` handler with the account details in the payment's **public metadata** (storefronts render them), eligibility checker (min / max, guests, customer groups), auto-expiry after N days, reminder event, admin *received* / *cancel*. Optional **Stripe bank transfers**: each customer pays into their own Stripe virtual account and the order settles by itself when the money arrives. |
| **Guards** | Session-bound anonymous `orderByCode`; trusted client-IP contract for server-side proxies; token-bucket rate limits on checkout mutations. |
| **Observability** | Payment-event log (failed, client-declined, orphan, amount drift, expired), nightly Stripe reconciliation per channel, amount-drift guard, checkout funnel events with drop-off, ops alerts (Slack / Discord / Teams / Telegram / signed webhook / email). |
| **Admin dashboard** | *Sales → Checkout Guard*: Overview (set-up checklist, KPIs, value metrics), Holds, Bank transfers, Payment events, Funnel, Settings (weekly report), Licence & billing. Plus a dashboard widget. |
| **Weekly report** | Monday 08:00 e-mail with the week's numbers (holds, held value, bank transfers, rate-limited abuse, denied lookups, orphans) and the next set-up step. |

## Install

```bash
yarn add @huloglobal/vendure-plugin-checkout-guard
```

```ts
import { CheckoutGuardPlugin, SessionBoundOrderByCodeAccessStrategy } from '@huloglobal/vendure-plugin-checkout-guard';

export const config: VendureConfig = {
    orderOptions: {
        // Anonymous orderByCode only from the session that placed the order.
        orderByCodeAccessStrategy: new SessionBoundOrderByCodeAccessStrategy('2h'),
    },
    plugins: [
        CheckoutGuardPlugin.init({
            publicBaseUrl: 'https://api.example.com',
            licenceKey: process.env.HULO_LICENCE_KEY_CHECKOUT_GUARD,
            stripe: { webhookSecret: process.env.STRIPE_CG_WEBHOOK_SECRET, safetyCaptureDays: 6 },
            bankTransfer: { expiryDays: 7, reminderAfterDays: 3 },
            reconciliation: { enabled: true, lookbackDays: 3 },
            trustedClientIp: {
                secret: process.env.CHECKOUT_GUARD_PROXY_SECRET,
                // Reverse proxies / load balancers in front of the API (plain IPs or CIDRs).
                trustedProxies: ['10.0.0.0/8'],
            },
            ops: { slackWebhookUrl: process.env.OPS_SLACK_WEBHOOK_URL, adminEmail: 'ops@example.com' },
        }),
    ],
};
```

Admin UI: add `CheckoutGuardPlugin.uiExtensions` to your `compileUiExtensions`
list. That registers the *Sales → Checkout Guard* page and the dashboard
widget (**Dashboard → Add widget → Checkout Guard**). The plugin adds an Order
custom field `cgSessionHash` — run your migrations (or `synchronize`) after
install:

```sql
ALTER TABLE `order` ADD `customFieldsCgsessionhash` varchar(64) NULL;
```

Tables `checkout_guard_payment_event`, `checkout_guard_funnel_event`,
`checkout_guard_bank_transfer`, `checkout_guard_state`, `cg_counter` and the
shared `hulo_plugin_prefs` are created on boot (MySQL / MariaDB / PostgreSQL
via the licence SDK's dialect adapter).

## Stripe holds

1. In the Vendure admin create a **payment method per channel** with handler
   *Stripe hold* (`stripe-hold`). It has no arguments: it reads the channel's
   Stripe secret key from the channel's existing Stripe payment method.
2. In Stripe create a webhook endpoint at
   `https://<api>/checkout-guard/stripe-webhook` for
   `payment_intent.amount_capturable_updated`, `payment_intent.payment_failed`
   and `payment_intent.canceled`. Put the signing secret in
   `stripe.webhookSecret`, or per channel in
   `STRIPE_CG_WEBHOOK_SECRET_<CHANNELCODE>` (upper-cased, non-alphanumerics →
   `_`; the default channel is `STRIPE_CG_WEBHOOK_SECRET_DEFAULT_CHANNEL`).
3. Create PaymentIntents with `capture_method: 'manual'` where you want a
   hold (Vendure's `StripePlugin.init({ paymentIntentCreateParams })`).

When the customer confirms, Stripe emits `amount_capturable_updated`; the
plugin verifies the signature (raw body, never a fallback), resolves the
channel from the intent's Vendure metadata, retrieves the **live**
PaymentIntent from Stripe (events are retried for days and can describe a
state the intent has long left), moves the order to `ArrangingPayment` if
needed and adds an **Authorized** payment. An intent that is already
`succeeded` (captured in the Stripe dashboard before the event arrived) is
recorded and settled straight away; one that is `canceled` is logged as a
`hold_expired` payment event and no payment is added. The order is placed.
Holds below `autoCaptureBelowMinor` are captured right after the recording
transaction commits — never while the order row is locked. Capture it from *Checkout Guard → Holds* (settles the payment)
or from the order page; cancel releases the hold. The safety cron captures
any hold older than `safetyCaptureDays` (default 6) and alerts you.
Storefronts should treat `PaymentAuthorized` as "payment authorised, under
review".

## Bank transfer

Create a payment method with handler *Bank transfer* (`bank-transfer`) and
fill in account name, number, sort code, IBAN, BIC, instructions and expiry
days; optionally add the *Bank transfer eligibility* checker. When the
storefront calls `addPaymentToOrder(method: 'bank-transfer')` the order
becomes `PaymentAuthorized` and the payment's `metadata.public` carries
`{ accountName, accountNumber, sortCode, iban, bic, reference, amountMinor,
currency, payBy, instructions }` — render that on the payment step and on
the confirmation page while the order is `PaymentAuthorized`. Unpaid orders
expire after `expiryDays` (cancelled, `BankTransferExpiredEvent`); a
`BankTransferReminderEvent` fires once after `reminderAfterDays` — subscribe
to both to email the customer. Mark money received from the dashboard.

### Stripe bank transfers

Off by default. Turn it on and every bank-transfer order in GBP goes through
Stripe instead of your own account: Stripe gives the customer a virtual UK
account (sort code and account number) and a reference, matches the incoming
Faster Payment or BACS credit to the order, and the plugin settles the
payment, so the order moves to `PaymentSettled` and your fulfilment runs
without anyone matching payments by hand.

```ts
CheckoutGuardPlugin.init({
    // …
    bankTransfer: {
        expiryDays: 7,
        reminderAfterDays: 3,
        stripe: { enabled: true },   // currencies: ['GBP'] by default
    },
});
```

**Set-up**

1. **Bank transfers on the Stripe account, and only for this plugin.** In the
   Stripe dashboard turn on *Bank transfers* (the customer balance payment
   method) for GBP. That switch also offers bank transfer in every payment
   that uses Stripe's dynamic payment methods, which is what Vendure's
   `StripePlugin` creates for card checkout: signed-in customers would be
   offered a Stripe bank transfer inside the card form, outside Checkout
   Guard (no expiry, no reminders, Stripe's own instructions). Keep it out of
   the card flow:

   ```ts
   StripePlugin.init({
       // …
       skipPaymentIntentsWithoutExpectedMetadata: true,   // see step 4
       paymentIntentCreateParams: () => ({ excluded_payment_method_types: ['customer_balance'] }),
   });
   ```

   (merge it into the object your `paymentIntentCreateParams` already
   returns, or point `payment_method_configuration` at a payment method
   configuration without bank transfers). Check in test mode that the card
   form no longer offers bank transfer, and that a bank-transfer order still
   gets its Stripe account.
2. **The Stripe secret key** is read from the channel's Vendure Stripe payment
   method (handler `stripe`, argument `apiKey`), as for holds. Vendure also
   assigns every new payment method to the default channel, so the default
   channel can see another channel's Stripe method (another Stripe account).
   For bank transfers the plugin prefers the Stripe method that belongs to the
   channel alone, and logs its choice once per channel (`Stripe bank transfers
   on channel 1 use the Stripe payment method "stripe"`): check that line
   before going live. A channel without a key keeps your own bank details.
3. **Webhook.** On every Stripe endpoint that targets
   `https://<api>/checkout-guard/stripe-webhook` (one per Stripe account), add
   `payment_intent.succeeded` (this settles the order),
   `payment_intent.partially_funded` (the amount still due is updated) and
   `customer_cash_balance_transaction.created` (money that paid no order is
   reported); `payment_intent.canceled` is already on the list for holds. The
   signing secrets are the ones used for holds: `stripe.webhookSecret`, or per
   channel `STRIPE_CG_WEBHOOK_SECRET_<CHANNELCODE>` (the channel comes from the
   intent's `cg_channel_id` metadata). One URL usually serves endpoints on
   several Stripe accounts, and they also deliver events for payments that are
   not Vendure's. So in this mode an event the channel's secret cannot verify
   is checked against the other configured secrets: an event without Vendure
   metadata is then acknowledged as before, and one that names a channel but
   is signed for another account's endpoint is acknowledged and never acted
   on. Likewise, while premium is locked the hold module answers 200 (not
   503) for events about payments that are not holds, so days of retries
   cannot get the shared endpoint disabled.
4. **Vendure's StripePlugin must skip these intents.** They carry only
   Checkout Guard's metadata (`cg_bank_transfer`, `cg_order_code`,
   `cg_order_id`, `cg_channel_id`), never `channelToken` / `orderCode` /
   `orderId`, so Vendure's own Stripe webhook throws on them and Stripe keeps
   retrying it for days. Set
   `StripePlugin.init({ skipPaymentIntentsWithoutExpectedMetadata: true })`
   before you enable this.
5. **Copy.** The reference is now Stripe's, not the order code. Any storefront,
   e-mail or invoice text that says "quote your order number", or shows your
   own account for a bank-transfer order, must show `metadata.public`
   (`sortCode`, `accountNumber`, `reference`) instead; money sent to your own
   account has to be marked received by hand.

**What the customer sees.** `metadata.public` keeps its field names, so
storefronts and e-mails that render the static details render these too:
`{ method: 'bank-transfer', provider: 'stripe', accountName, sortCode
('12-34-56'), accountNumber, reference (Stripe's), amountMinor (what is still
to pay), currency, payBy, expiryDays, instructions, hostedInstructionsUrl }`.
There is no `iban` / `bic`: your own account's are never shown next to
Stripe's. The default instructions ask the customer to send the exact amount
and quote the reference, and say that Faster Payments usually arrive within
hours and BACS can take up to three working days; replace them with
`stripe.instructions` (`{reference}` is filled in). Once part of the money has
arrived, `amountMinor` is lowered to what is still due, so the confirmation
page and the reminder e-mail ask only for the rest. The PaymentIntent id, the
Stripe customer and the channel are kept in the payment's admin-only metadata
(`paymentIntentId`, `stripeCustomerId`, `stripeChannelId`). The payment's
`transactionId` stays the order code.

**Whose Stripe customer.** Stripe applies a customer's whole cash balance to a
new PaymentIntent the moment it is confirmed, so the Stripe customer must
really be the shopper's:

- **Signed in as the order's customer** (a registered account): the Stripe
  customer the plugin created for that Vendure customer and user is reused
  (found by e-mail, then checked by its `cg_vendure_customer_id` and
  `cg_vendure_user_id` metadata), so a returning customer pays into the same
  account every time, and their own balance (an earlier overpayment, say) pays
  for the order: in full, and the payment is recorded as *Settled*, or in
  part, and the instructions ask for the rest.
- **Anyone else** (guest checkout): a new Stripe customer for that order alone
  (metadata `cg_order_code`), with its own virtual account and no balance.
  Typing someone's e-mail address at checkout never reaches their Stripe
  customer or their money. A Stripe customer with the same e-mail that someone
  else created (Vendure's `StripePlugin`, another integration) is never used.

**How it settles.** The plugin creates and confirms a `customer_balance`
PaymentIntent with funding type `bank_transfer` (idempotency key from the order
code and amount) and records the payment as *Authorized*, so the order is placed
as before. Then:

- `payment_intent.succeeded` → the order's Authorized bank-transfer payment for
  that intent is settled under a row lock, in the order's own channel, and its
  tracking row is marked settled, exactly like *Mark received*. Redeliveries are
  harmless. Nothing is settled (and `bank.stripe_unsettled` is raised, since the
  money is at Stripe) when the order is cancelled or already paid some other
  way, or Stripe received less than the payment.
- A **sweep** on the worker (every ten minutes, at 5, 15 … 55 past the hour,
  under the same lock as the expiry sweep) asks Stripe about each open
  Stripe transfer of an order still awaiting payment, newest first and at most
  once per ten minutes per payment, and settles those that have succeeded, in
  case a webhook was missed. It starts no new check after three minutes, so it
  never holds the lock into the next expiry sweep.
- A **part-paid** transfer stays open: the log shows what was received and the
  `amount_remaining`, and the customer can send the rest.
- Before the expiry sweep expires a Stripe transfer it asks Stripe first. Paid:
  the order is settled instead. Stripe unreachable: it is not expired on that
  pass, and once it is a day past its pay-by date `bank.stripe_check_failed`
  asks you to look. Stripe saying the intent is not on that account (a changed
  key): it is expired as usual.

**Settling by hand.** *Mark received*, or Vendure's *Settle payment*, still
works, for a customer who paid your own account anyway. If Stripe has the money
after all, it counts as Stripe's settlement. Otherwise the plugin cancels the
PaymentIntent, so a later transfer to the customer's virtual account cannot be
matched to this already paid order without anyone noticing; a part payment
that had already arrived through Stripe raises `bank.stripe_partially_funded`.
If Stripe later reports a transfer for a payment settled by hand,
`bank.stripe_unsettled` warns that the customer may have paid twice.

**Cancelling.** When an unpaid transfer expires, its payment is cancelled
(from *Checkout Guard → Bank transfers* or Vendure's *Cancel payment*), or its
order is cancelled in Vendure (*Cancel order* leaves payments alone, so the
plugin cancels the open Stripe transfer of a cancelled order itself), the
plugin cancels the PaymentIntent at Stripe, best effort. A transfer Stripe says
is already paid is not cancelled; settle it instead (for an order that is
already cancelled, `bank.stripe_unsettled` asks you to refund or reinstate it).
If the cancel fails, the Vendure payment is still cancelled and
`bank.stripe_cancel_failed` asks you to cancel the intent in the Stripe
dashboard. **Money that arrives after the intent is cancelled, and any
part-payment it was holding, stays in the customer's Stripe cash balance.** A
cancelled part-paid transfer raises `bank.stripe_partially_funded` with the
amount, and money left in the cash balance of a customer the plugin created
(a late transfer, an overpayment) raises `bank.stripe_unsettled`, once per
amount. Refund it from the Stripe dashboard (*Customers → the customer → Cash
balance → Initiate refund*). Left there, it is applied to that customer's next
bank-transfer order (Stripe's default automatic reconciliation), and Stripe
itself tries to return balances that stay unreconciled for 75 days. Refunds of
settled Stripe transfers are made from the Stripe dashboard too.

**Never breaks checkout.** If Stripe cannot be used for an order (no key on the
channel, an API error, no answer within 15 seconds, Stripe refusing the
currency, a reply without transfer instructions, or Stripe applying a cash
balance to a guest's order) the order gets the payment method's own details
exactly as before, a warning is logged and `bank.stripe_fallback` is raised;
that order is settled by hand. When the PaymentIntent request itself got no
answer, Stripe may have created the intent anyway: 30 seconds and again 5
minutes later the plugin lists that customer's intents for the order and
cancels any that no payment carries (one already paid raises
`bank.stripe_unsettled`).

**Submitted twice.** Two `addPaymentToOrder` calls for one checkout (a double
click) would otherwise race, and Stripe answers the second with the first one's
PaymentIntent. In this mode the handler locks the order row before it calls
Stripe; the request that comes second sees the order already placed and gets an
`Error` payment (`PaymentFailedError` in the Shop API) instead of a second
payment for the same PaymentIntent. Should two payments carry one
intent all the same, only one is ever settled, and `bank.stripe_unsettled`
names the duplicate to cancel; cancelling it leaves the PaymentIntent alone.

**Time and locks.** The Stripe calls (normally two, never more than 15
seconds in all) run inside Vendure's `addPaymentToOrder` transaction, like any
payment handler's. During that time the order row is locked, and when the order
has coupon codes, Vendure's own lock on those promotions makes other checkouts
with the same coupon wait for at most that long, well inside MySQL's 50-second
lock wait.

**Alerts.** `bank.stripe_fallback`, `bank.stripe_cancel_failed`,
`bank.stripe_unsettled`, `bank.stripe_partially_funded` and
`bank.stripe_check_failed` reach your `ops` channels on every tier: Stripe bank
transfers are a free-tier feature, and each of these means money or a customer
that needs a human.

**Currencies.** `currencies` defaults to `['GBP']` (`gb_bank_transfer`). `EUR`
(`eu_bank_transfer`, an IBAN and BIC instead of a sort code) works when the
Stripe account accepts EUR bank transfers and `euCountry` is set (`BE`, `DE`,
`FR`, `IE` or `NL`; Stripe currently issues no new Spanish IBANs). Orders in any
other currency keep your own details. Stripe bank transfers work on every
tier: settling a paid order never waits on a licence. Automatic expiry and
reminders stay premium.

## Guards

- **Session-bound order lookup.** Vendure's default lets anyone with an
  order code read a fresh order for two hours. The strategy above allows the
  owner, or an anonymous session whose token hash matches the one stored on
  the order at creation. Pass `{ allowUnboundOrders: true }` to keep the
  default behaviour for orders created before install.
- **Trusted client IP.** Your storefront's server-side proxy forwards the
  real IP in `x-real-client-ip` and proves itself with
  `x-checkout-guard-proxy: <secret>`. Without the secret the header is
  stripped, so nothing downstream (fraud scoring, logs) can be spoofed by a
  browser. That path always wins. For everything else `getClientIp(req, opts)`
  resolves the address in this order:
  1. the verified `x-real-client-ip`;
  2. `cf-connecting-ip`, when `trustCloudflareHeader` is on;
  3. `x-forwarded-for`, **only** when `trustedProxies` is set and the TCP
     peer (`req.socket.remoteAddress`) is in it — the value is the
     right-most entry that is not itself a trusted proxy (the address the
     nearest trusted hop appended), so a browser cannot inject one;
  4. `req.ip` (Express applies your own `apiOptions.trustProxy` setting);
  5. the socket address.

  `trustedClientIp.trustedProxies` takes IPv4/IPv6 addresses or CIDRs
  (`['10.0.0.0/8', '173.245.48.0/20', '2400:cb00::/32']`); an invalid entry
  fails at boot. `trustCloudflareHeader` defaults to `true` only when
  `trustedProxies` is set (put Cloudflare's ranges in the list — the header
  is then only read from a trusted peer); otherwise it defaults to `false`,
  because an origin reachable without Cloudflare can be sent any value.
  Without `trustedProxies`, `x-forwarded-for` is never consulted: set
  `trustedProxies` or Express `trustProxy` so per-client rate limits still
  see individual clients behind your proxy.
- **Rate limits.** Defaults: `applyCouponCode` 10/min, `addPaymentToOrder`
  6/min, `createStripePaymentIntent` 6/min, `transitionOrderToState` 20/min
  per client IP; override with `rateLimits.mutations`. Limited requests get
  `429 { errors: [{ message: 'rate_limited' }] }`. IPv6 clients are bucketed per /64. GraphQL
  comments are stripped before matching, so `applyCouponCode # x\n(` cannot
  slip past the limiter.

- **Card-testing gate** (free, on by default). Every failed or client-declined
  card attempt is already recorded with its IP and order code; once an IP has
  4 failures in an hour its `createStripePaymentIntent` / `addPaymentToOrder`
  calls get `429 { errors: [{ message: 'card_testing_blocked' }] }` for 12 h,
  and once an order has 3 failures the host can refuse a new PaymentIntent:

  ```ts
  StripePlugin.init({
      paymentIntentCreateParams: async (injector, ctx, order) => {
          const verdict = await injector.get(CheckoutGuardService)
              .cardTestingVerdict({ orderCode: order.code, ip: getClientIp(ctx.req, trustedClientIp) });
          if (verdict.blocked) throw new Error(verdict.message!);
          return {};
      },
  })
  ```

  Tune with `cardTesting: { maxFailedPerIp, maxFailedPerOrder, windowMinutes,
  blockMinutes, mutations }` or switch off with `cardTesting: false`. Each trip
  raises the ops event `payment.card_testing` once per IP per block window.
  The gate keys on the resolved client IP, so `trustedClientIp.trustedProxies`
  must list **every** hop between the internet and Vendure (CDN ranges, the TLS
  proxy, a local nginx on loopback) — otherwise all shoppers share one address.

## Observability

- `POST /checkout-guard/client-decline { orderCode, code, message, paymentIntentId?, amountMinor?, currency? }` —
  the storefront reports synchronous `confirmPayment` failures (Stripe sends
  no webhook for those). Rate limited, always 200.
- `POST /checkout-guard/funnel { step, orderCode?, sessionId?, detail? }` with
  `step` ∈ `cart | address | payment | pay_attempt | pay_failed | coupon_rejected | placed`.
- Reconciliation runs daily at 04:10 on the worker: every succeeded or held
  PaymentIntent in the last `lookbackDays` is matched to a Vendure payment;
  unmatched ones are logged as `orphan` and alerted. `POST /checkout-guard/reconcile/run` runs it now.
- A settled payment whose amount differs from the order total is logged as
  `amount_drift` and alerted. The check runs once the order has left the
  payment phase, so a split payment (gift card + card) is not reported.
- Retention (worker, 03:20): funnel beacons are kept 90 days, `failed` and
  `client_declined` events 180 days, everything else 400 days.
- Admins working in a non-default channel only see that channel's events,
  bank transfers and KPIs; the default channel sees every channel.
- `countRecentFailures(ip, minutes)` on `ObservabilityService` is what the
  HULO Fraud Prevention plugin uses for its *failed payments* signal.

## Endpoints

| Method | Path | Who |
|---|---|---|
| POST | `/checkout-guard/stripe-webhook` | Stripe (signed) |
| GET | `/checkout-guard/holds?due=` | Admin |
| POST | `/checkout-guard/holds/:paymentId/capture` · `/cancel` | Admin |
| GET | `/checkout-guard/bank-transfers?status=awaiting|expired|settled|cancelled|all` | Admin |
| POST | `/checkout-guard/bank-transfers/:paymentId/received` · `/cancel` | Admin |
| POST | `/checkout-guard/client-decline` | Public (rate limited) |
| POST | `/checkout-guard/funnel` | Public (rate limited) |
| GET | `/checkout-guard/events?kind=&days=` · `/summary` · `/funnel/summary?days=` | Admin |
| POST | `/checkout-guard/reconcile/run` | Admin |
| GET | `/checkout-guard/meta` · `/settings` · `/setup` · `/widget` | Admin |
| GET/POST | `/checkout-guard/digest/settings`, POST `/digest/send-test`, GET `/digest/preview` | Admin |
| POST | `/checkout-guard/eval/remind-me` | Admin |
| POST | `/checkout-guard/licence/activate` · `/deactivate` · `/purchase-link` · `/portal-link`, GET `/licence/claim-status` | Admin |

## Weekly report, setup checklist and dashboard widget

**Weekly report.** Every Monday at 08:00 (server-local time) the worker
e-mails one report covering the previous seven days, with the week before
for comparison: Stripe holds placed, captured and released, the value held
on customers' cards, bank transfers confirmed, abusive checkout requests
rate-limited, `orderByCode` lookups refused to the wrong session, and
orphaned charges found by reconciliation. Quiet weeks say so. The report
also lists the next open set-up step and, on the trial or free tier, what a
licence adds. Every figure is a real query over the plugin's own tables and
Vendure's `payment` table — nothing is estimated.

- *Recipient:* `ops.adminEmail` from the plugin options, else the licence
  customer, else the address entered in "Email me before it ends". Override
  it in *Settings → Weekly report*; the card shows the default as the
  placeholder, when the last report went out and when the next is due.
- *Turn it off:* untick "Send the weekly report" on the same card (stored in
  `hulo_plugin_prefs`, no restart). **Send me a test** sends the week-to-date
  report now; **Preview** opens it in a new tab.
- *SMTP:* the report goes through the same `SMTP_SERVER`, `SMTP_PORT`,
  `SMTP_USER`, `SMTP_PASSWORD` and `SMTP_FROM` environment variables the ops
  e-mails use (falling back to `SMTP_HOST` / `SMTP_PASS`). Without them the
  card reports "not sent" and nothing else changes. `nodemailer` is a peer
  dependency.
- Sending is idempotent across worker replicas (compare-and-set on the
  last-sent timestamp); a failed send is retried on the next hourly tick.

**Set-up checklist.** The Overview tab opens with the five checks that make
the plugin useful — Stripe webhook secret, a `stripe-hold` payment method, a
`bank-transfer` payment method, the trusted client-IP contract (secret header
or `trustedProxies`) and an ops channel — each a real check against the
options and the payment-method table, with a link to where it is fixed.
*Hide* keeps it out of the way once everything is done; it comes back by
itself if a check regresses. The open items are the "next steps" in the
weekly report. (`orderOptions.orderByCodeAccessStrategy` lives in the host
config and cannot be detected — the Settings tab reminds you.)

**Dashboard widget.** *Dashboard → Add widget → Checkout Guard* shows three
headline figures from the last seven days (held value first, then the
largest counts), the licence notice when a trial or key is about to end, and
a link to the plugin page. It needs `ReadOrder`, like the page.

**Value metrics.** Overview tiles now include *Held value* (holds placed in
the last 30 days, in the holds' currency), *Rate-limit rejections* and
*Denied order lookups* (both 7 days). The last two come from a small
`cg_counter` table (one row per day and counter, buffered and written once
every two seconds, so a burst of 429s costs one statement) and are kept for
400 days by the retention cron. The same 30-day numbers travel with the
daily heartbeat and evaluation pings (numbers only, no personal data) so
renewal and reminder e-mails can say what the plugin did.

## Compatibility

Vendure `>=3.5.0 <4.0.0` (tested on 3.5, 3.6 and 3.7). MySQL, MariaDB and
PostgreSQL. Node 20 LTS or newer. Stripe features need
`@vendure/payments-plugin` Stripe configured with manual capture. REST routes
live under `/checkout-guard`; see [Endpoints](#endpoints).


## Tiers

**Free:** session-bound order lookup, trusted client IP, rate limits, funnel
events, the bank-transfer handler and checker (including Stripe bank transfers,
their automatic settlement and their `bank.stripe_*` alerts), the dashboard.
**Licensed (or the 14-day card-backed trial):** Stripe hold handling, bank-transfer
auto-expiry and reminders, failed-payment recording, reconciliation, the
amount-drift guard and ops alerts. Start the trial or buy from the admin
page; the licence installs itself.

## Licence

AGPL-3.0-or-later. Commercial licences: https://huloglobal.com/vendure-plugins/checkout-guard/
