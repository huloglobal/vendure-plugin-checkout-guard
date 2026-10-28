# Changelog

All notable changes to `@huloglobal/vendure-plugin-checkout-guard` are
documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project
adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.4] — 2026-10-28

### Changed
- Every install now gets a 14-day evaluation with all features on and no card (granted by the HULO licence server). The licence banner's buttons read **Subscribe**: during the evaluation the first charge falls on the day it ends, so there is no second free trial.

## [0.2.3] — 2026-10-15

### Fixed
- Test expectations for the 0.2.2 channel change (0.2.2 is deprecated on npm; same runtime code).

## [0.2.2] — 2026-10-15

### Fixed
- An order's channel was resolved as the *lowest* channel id it belongs to.
  Every order also belongs to the default channel, so on multi-channel stores
  client-side declines and bank-transfer rows were attributed to the default
  channel. The highest channel id (the storefront's own) is used now.

## [0.2.1] — 2026-10-15

### Added
- **Card-testing gate** (free tier, on by default). Carders run stolen cards
  through the cheapest product until one works; Radar declines them but every
  attempt still mints a PaymentIntent and shares the rate-limit buckets with
  real shoppers. The gate reads the plugin's own failed/client-declined
  records: once an IP has `maxFailedPerIp` (4) failures in `windowMinutes`
  (60) the payment mutations (`createStripePaymentIntent`, `addPaymentToOrder`)
  answer `429 card_testing_blocked` for `blockMinutes` (720), and
  `CheckoutGuardService.cardTestingVerdict({ orderCode, ip })` lets the host's
  `paymentIntentCreateParams` hook refuse a new intent once an order has
  `maxFailedPerOrder` (3) failures. Ops event `payment.card_testing` (once per
  IP per block), counter `card_testing_block`, stat `cardTestingBlocked`.
  Configure or disable with the `cardTesting` option.

### Fixed
- The mutation rate limiter only recognised `name(` — argument-less mutations
  such as Vendure's `createStripePaymentIntent` were never limited. Names now
  match as whole words, with string literals blanked first so a name inside an
  argument value still does not count.
- `countRecentFailuresForOrder()` added next to `countRecentFailures()`.

## [0.2.0] — 2026-10-11

Merchant engagement release. Two small tables (`cg_counter`, and the shared
`hulo_plugin_prefs`) are created on boot; nothing to migrate. Requires
`@huloglobal/vendure-licence-sdk` 0.15.

### Added
- **Weekly report.** Monday 08:00 (server-local) e-mail from the worker with
  the week's holds placed / captured / released, held value, bank transfers
  confirmed, rate-limited requests, denied order lookups and orphaned
  charges — each with the previous week for comparison — plus the next open
  set-up step and, on trial/free, what a licence adds. Sent through the ops
  SMTP settings (`SMTP_*`), falling back to the SDK env transport. Recipient
  defaults to `ops.adminEmail`, then the licence customer, then the trial
  reminder address. `GET|POST /checkout-guard/digest/settings`,
  `POST /digest/send-test`, `GET /digest/preview`, and a *Weekly report* card
  in the Settings tab (toggle, recipient, last/next, Send me a test, Preview).
- **Set-up checklist** on the Overview tab (`GET /checkout-guard/setup`):
  Stripe webhook secret, `stripe-hold` method, `bank-transfer` method,
  trusted client IP (secret header or `trustedProxies`), ops channel — real
  checks, with links to the fix. Hideable once complete; reappears if a check
  regresses. Replaces the static checklist in Settings.
- **Dashboard widget** (`registerDashboardWidget`, *Dashboard → Add widget →
  Checkout Guard*): three 7-day headline figures, the licence notice and a
  link to the page. `GET /checkout-guard/widget`.
- **Usage counters.** `cg_counter` (day, name, n) records Shop API rate-limit
  rejections and session-bound `orderByCode` refusals (fire-and-forget,
  buffered, one upsert per counter every two seconds). New Overview tiles
  *Held value (30d)*, *Rate-limit rejections (7d)* and *Denied order lookups
  (7d)*; `summary` gains a `usage` block.
- **Usage stats to the licence server.** `holdsPlaced`, `holdsCaptured`,
  `holdsCancelled`, `heldValuePence`, `bankTransfersConfirmed`,
  `rateLimitRejections`, `orderAccessDenied`, `orphansFound` (last 30 days,
  numbers only) ride on the daily heartbeat and evaluation pings — licensed
  installs keep reporting after purchase.
- **Licence banner.** `meta` now carries `notice` (trial / key / evaluation
  lifecycle sentence, shown as an amber strip), `premiumFeatures`,
  `recentStats` ("So far: £… held on customers' cards · …") and `buyUrl`.
  The trial banner gains "Email me before it ends" (wired to the existing
  `eval/remind-me`; the address is remembered as the report's fallback
  recipient). Every 402 and `licence_required` / `premium-feature` error in
  the admin now reads "… needs a licence — start the free trial or activate a
  key at the top of this page."

### Changed
- `402` bodies from the hold capture/cancel endpoints include `buyUrl`.
- Retention cron also prunes `cg_counter` after 400 days.
- `ReconciliationService` and `ObservabilityService` accept the new
  `CounterService`; `OpsAlertService` exposes `sendMail()`, `hasSmtp()` and
  `adminEmail()`.
- **Heartbeat reports the key in force.** The daily ping now reads the
  active licence through `licenceKeyProvider`, so a key activated from the
  admin, installed by the purchase claim or restored at boot is reported
  under its own jti instead of "unlicensed" (the licence server dropped the
  usage stats for those installs before).
- Licence SDK dependency raised to `^0.15.1`.

## [0.1.4] — 2026-09-28

Follow-up to the 0.1.3 audit. No schema changes; nothing to migrate.

### Changed
- **Client-IP trust model.** `trustedClientIp.trustedProxies` (IPv4/IPv6
  addresses or CIDRs) names the proxies in front of the API.
  `x-forwarded-for` is now only consulted when the TCP peer is one of them,
  and the client address is the right-most entry that is not itself a
  trusted proxy — a browser can no longer inject an address into the rate
  limiter, funnel or decline log. Without `trustedProxies` the header is
  ignored and `req.ip` (your `apiOptions.trustProxy` setting) or the socket
  is used. `trustCloudflareHeader` now defaults to `false` unless
  `trustedProxies` is set or it is enabled explicitly; with `trustedProxies`
  it is only read from a trusted peer. The secret-header path
  (`x-real-client-ip` + `x-checkout-guard-proxy`) is unchanged and still
  wins. Invalid `trustedProxies` entries fail at boot. The effective values
  are shown in the Settings tab. **Hosts that relied on the first
  `x-forwarded-for` entry without `trustProxy` should set `trustedProxies`.**
- **Auto-capture off the row lock.** A below-threshold hold is now captured
  after the recording transaction commits (same result, same alerts); the
  Stripe capture call no longer runs while `SELECT … FOR UPDATE` is held on
  the order row. If the capture fails the hold stays Authorized and a
  `hold.capture_failed` alert is raised instead of rolling the hold back.
- **Live intent check before recording a hold.** Before
  `amount_capturable_updated` adds a payment, the PaymentIntent is retrieved
  from Stripe (outside the transaction). `requires_capture` proceeds as
  before; `succeeded` is recorded and settled immediately (captured in the
  dashboard before the event was delivered); `canceled` is logged as a
  `hold_expired` payment event with a `hold.expired` alert and no payment is
  added; any other status is ignored. A redelivered event is de-duplicated
  before the Stripe call. When the channel has no Stripe key or Stripe is
  unreachable the signed event payload is used as before.
- **Admin UI.** Effective settings are cached after the first load (only
  Refresh re-fetches them) and every HTTP/modal subscription is torn down
  when the page is left.

### Added
- Unit tests for `StripeHoldService` (webhook flow, dedupe, channel/order
  errors, transition failure, premium lock, capture/cancel state mapping,
  safety capture), `BankTransferService` (channel-scoped listing, mark
  received / cancel incl. stale-under-lock, sweep expire + remind, stranded
  repair) and `ReconciliationService.runOnce` (orphan rows, second-run
  dedupe, single alert, persisted last run) on lightweight fakes — no
  database.
- Postgres corpus test (`src/__tests__/pg-corpus.test.ts`, runs when
  `HULO_PG_URL` is set): extracts every SQL template literal, translates it
  through the dialect adapter and executes it against PostgreSQL 17 with
  quoted-camelCase stand-ins for the Vendure tables. 37/37 statements pass.
- `parseCidr`, `isTrustedProxy`, `clientIpFromForwardedFor`, `ipToBigInt`
  are exported for hosts that want the same matcher.

## [0.1.3] — 2026-09-28

Reliability and performance pass — no new features. One small table
(`checkout_guard_state`) and two best-effort indexes on `payment` are
created on boot; nothing to migrate.

### Fixed
- **Bank transfer settle/cancel race.** "Mark as received" (server) and the
  expiry sweep (worker) now settle or cancel under a `SELECT … FOR UPDATE`
  with the payment state re-read inside the transaction, so a paid order can
  no longer be cancelled by an overlapping sweep. The sweep also takes a
  cross-process lock, records `expiredAt` before it cancels, and the
  stranded-order repair only touches orders the sweep itself expired.
- **Stripe hold capture/cancel race.** The hourly safety capture, a
  `payment_intent.succeeded` webhook and an admin click can overlap: capture
  and release now lock the payment row and re-check its state; a hold that
  is already Settled/Cancelled reports success to non-admin callers instead
  of raising a `capture_failed` alert.
- **Postgres.** Every raw query that touches a Vendure table quotes its
  camelCase columns (`transactionId`, `createdAt`, `orderId`, `channelId`,
  `currencyCode`, `emailAddress`, `customerId`), which Postgres otherwise
  folds to lowercase. Bank-transfer listing and sweep, orphan and hold KPIs,
  `findOrderByCode` and reconciliation's known-intent set were silently
  empty on Postgres hosts before.
- **Ops alerts never hold a Stripe webhook.** Alerts from the hold path are
  fire-and-forget; one pooled SMTP transport with 5 s connect / 10 s socket
  timeouts and a 12 s send cap replaces a fresh transport per e-mail;
  `hold.webhook_error` is delivered even when premium is locked and is also
  logged at error level; chat webhooks now treat non-2xx as a failure.
- **Rate limiter.** GraphQL comments are stripped before the mutation
  matcher runs (`applyCouponCode # x\n(` was invisible to it); IPv6 clients
  are bucketed per /64.
- **Channel scoping.** Admins working in a non-default channel only see and
  act on that channel's bank transfers, payment events, KPIs and funnel.
- **Amount drift** is evaluated only once the order has left the payment
  phase, so multi-payment checkouts are not reported as underpaid.
- **Permissions.** Self-update, licence activate and deactivate require
  SuperAdmin (they were reachable with `UpdateOrder`). `paymentId` route
  params are validated. Purchase-link failures no longer echo upstream
  error text; the evaluation reminder validates the e-mail and times out
  after 8 s. `webhookSecretConfigured` also honours the
  `STRIPE_CG_WEBHOOK_SECRET*` environment variables.
- Tracking rows are inserted with `INSERT IGNORE` (no duplicate-key 500
  after a concurrent settle).

### Changed
- **Funnel summary is aggregated in SQL** (`GROUP BY step` with
  `COUNT(DISTINCT …)`) instead of loading every beacon in the window into
  Node; `summariseFunnelCounts` exposes the same pure summary from counts.
- **Retention cron** (worker, 03:20): funnel beacons 90 days, `failed` and
  `client_declined` events 180 days, all other payment events 400 days.
  Both tables grew without bound before.
- **Reconciliation** takes a cross-process lock (admin "Run now" vs the
  04:10 worker run), persists its last result in `checkout_guard_state` so
  the dashboard shows it whichever process ran it, reads known intents in
  one query and de-duplicates orphans in batches of 500 instead of one
  `SELECT` per intent.
- Best-effort indexes `idx_cg_payment_txn (transactionId)` and
  `idx_cg_payment_state_method (state, method)` on Vendure's `payment`
  table (skipped silently where the host cannot create them).
- Payment-method lookups are cached for 30 s (bank-transfer codes, Stripe
  keys) and handler-code `LIKE` patterns are escaped rather than stripped.
- Admin UI: OnPush change detection, `trackBy` on every table, cached
  currency formatters, and the overview fetches 8 recent events instead of
  200.

## [0.1.2] — 2026-09-18

### Changed
- **Vendure plugin directory readiness.** The plugin class, every service and the bank-transfer events carry `@category` JSDoc tags (Plugin / Services / Events); the runtime `compatibility` declaration now matches the tested range `>=3.5.0 <4.0.0` instead of `^3.0.0`.
- **README:** npm, download, Vendure and database badges, a four-step *Quick start* at the top (including the admin-UI compile step) and a *Compatibility* section. No functional changes.

## [0.1.1] — 2026-09-11

### Fixed
- **Admin capture / release of a hold on a non-default channel** used the admin request's channel, where the channel's `stripe-hold` method does not exist (`error.payment-method-not-found`). Both now act in the order's own channel, like the cron and webhook paths.
- **Webhook responses:** an unexpected error while recording a hold, or a locked premium tier, now answers 5xx so Stripe retries the delivery instead of the hold being lost; an ops alert (at most hourly) explains the locked case.
- **Duplicate webhook deliveries** for one PaymentIntent are serialised (in-process mutex plus a row lock on the order), so two Authorized payments can no longer be attached to one intent.
- Ops fan-out (Slack / webhooks / SMTP) no longer runs inside the webhook's database transaction.
- Capture / cancel idempotency keys carry a minute bucket, so a failed capture is not replayed as the same error for 24 hours.
- Safety capture releases (never charges) a hold whose order was cancelled.
- Bank-transfer sweep finishes cancelling orders that a failed `cancelOrder` left in PaymentAuthorized with a cancelled payment (`repaired` in the sweep result).
- Admin UI: the Bank transfers, Holds and Funnel tabs read the fields the server actually sends.
- Overview KPIs count holds and transfers by the handler behind each channel's payment method, not by a guessed method code.
- Shop API rate limiter: multipart (file-upload) GraphQL requests are limited too.
- `trustedClientIp.trustCloudflareHeader` (default true) lets deployments reachable without Cloudflare ignore `cf-connecting-ip`.

## [0.1.0] — 2026-09-11

### Added
- **Stripe holds.** A `stripe-hold` payment handler and a signed webhook (`POST /checkout-guard/stripe-webhook`) for `payment_intent.amount_capturable_updated`, so a manual-capture PaymentIntent becomes an *Authorized* Vendure payment and the order is placed (`PaymentAuthorized`). Capture and cancel from the admin (`/checkout-guard/holds`), a safety capture before Stripe's seven-day authorisation window closes, `payment_intent.payment_failed` recorded as a payment event. Per-channel webhook secrets via `STRIPE_CG_WEBHOOK_SECRET_<CHANNELCODE>`.
- **Bank transfer.** A `bank-transfer` payment handler whose account details travel in the payment's public metadata (storefronts render them, nothing hard-coded), an eligibility checker (min / max amount, guests, customer groups), auto-expiry of unpaid orders after N days with a reminder event before that, and admin *received* / *cancel* actions.
- **Guards.** `SessionBoundOrderByCodeAccessStrategy` (anonymous `orderByCode` only from the session that placed the order, via the `cgSessionHash` Order custom field), a trusted client-IP middleware (`x-real-client-ip` honoured only with the `x-checkout-guard-proxy` secret header) with `getClientIp()`, and token-bucket rate limits on Shop API mutations (`applyCouponCode`, `addPaymentToOrder`, `createStripePaymentIntent`, `transitionOrderToState`).
- **Observability.** A payment-event log (webhook failures, storefront-reported declines, orphaned charges, amount drift, expired holds and transfers), `POST /checkout-guard/client-decline`, nightly Stripe ↔ Vendure reconciliation per channel, an amount-drift guard on settlement, checkout funnel events (`POST /checkout-guard/funnel`) with a per-step summary, and ops alerts to Slack, Discord, Teams, Telegram, a signed webhook and email.
- **Admin dashboard** at *Sales → Checkout Guard*: Overview, Holds, Bank transfers, Payment events, Funnel, Settings, plus the Licence & billing card (14-day card-backed trial, buy from the admin, Stripe billing portal).
- Free tier: session-bound order lookup, trusted client IP, rate limits, funnel events, the bank-transfer handler and checker, dashboard. Premium: Stripe holds, bank-transfer expiry and reminders, failed-payment recording, reconciliation, drift guard, ops alerts.
