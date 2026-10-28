import { ChangeDetectionStrategy, Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { NotificationService, ModalService } from '@vendure/admin-ui/core';

/** REST prefix shared with the plugin controllers. */
const API = '/checkout-guard';

type Tab = 'overview' | 'holds' | 'bank' | 'events' | 'funnel' | 'settings';
type BankStatus = 'awaiting' | 'expired' | 'settled';

interface HoldRow {
    paymentId: number | string;
    orderId?: number | string;
    orderCode?: string;
    channelCode?: string;
    amount?: number;
    currency?: string;
    authorisedAt?: string;
    expiresAt?: string;
    transactionId?: string;
}

interface BankRow {
    paymentId: number | string;
    orderId?: number | string;
    orderCode?: string;
    channelCode?: string;
    amount?: number;
    currency?: string;
    reference?: string;
    payBy?: string;
    createdAt?: string;
    state?: string;
    reminderSentAt?: string | null;
    customerEmail?: string;
}

interface EventRow {
    id: number | string;
    channelId?: number;
    orderId?: number | string | null;
    orderCode?: string | null;
    kind: string;
    provider?: string;
    providerRef?: string | null;
    code?: string | null;
    message?: string | null;
    amountMinor?: number | null;
    currency?: string | null;
    ip?: string | null;
    createdAt: string;
}

interface FunnelStep {
    step: string;
    label: string;
    count: number;
    /** Drop-off from the previous step, as a percentage (null on the first step). */
    dropOffPct: number | null;
    /** Share of the first step's count, for the mini bar. */
    sharePct: number;
}

interface SettingsSection {
    key: string;
    title: string;
    rows: Array<{ key: string; value: string }>;
}

interface SetupItemRow {
    key: string;
    label: string;
    done: boolean;
    hint: string;
    tab?: string;
    url?: string;
}

interface DigestSettings {
    enabled: boolean;
    recipient: string | null;
    defaultRecipient: string | null;
    lastSentAt: string | null;
    nextDueAt: string | null;
}

/** localStorage flag: the admin hid the (complete) set-up checklist. */
const SETUP_HIDDEN_KEY = 'hulo-vendure-plugin-checkout-guard-setup-hidden';

const FUNNEL_STEPS: Array<{ key: string; label: string }> = [
    { key: 'cart', label: 'Cart' },
    { key: 'address', label: 'Address' },
    { key: 'payment', label: 'Payment step' },
    { key: 'pay_attempt', label: 'Pay attempted' },
    { key: 'placed', label: 'Order placed' },
];
/** Side events: shown in the table but excluded from the drop-off chain. */
const FUNNEL_SIDE_STEPS: Array<{ key: string; label: string }> = [
    { key: 'pay_failed', label: 'Payment failed' },
    { key: 'coupon_rejected', label: 'Coupon rejected' },
];

const EVENT_KINDS: Array<{ key: string; label: string }> = [
    { key: 'failed', label: 'Payment failed' },
    { key: 'client_declined', label: 'Declined in browser' },
    { key: 'orphan', label: 'Orphaned charge' },
    { key: 'amount_drift', label: 'Amount drift' },
    { key: 'hold_expired', label: 'Hold expired' },
    { key: 'bank_expired', label: 'Bank transfer expired' },
];

const SETTINGS_SECTIONS: Array<{ key: string; title: string }> = [
    { key: 'general', title: 'General' },
    { key: 'stripe', title: 'Stripe holds' },
    { key: 'bankTransfer', title: 'Bank transfer' },
    { key: 'reconciliation', title: 'Stripe reconciliation' },
    { key: 'trustedClientIp', title: 'Trusted client IP' },
    { key: 'rateLimits', title: 'Rate limits' },
    { key: 'ops', title: 'Ops alerts' },
    { key: 'orderAccess', title: 'Order access' },
];

@Component({
    selector: 'hulo-checkout-guard',
    standalone: false,
    // The loaders already call markForCheck(); OnPush stops the template's
    // helper calls (money(), kpi(), relative()) re-running on every event.
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <!-- ── HULO brand hero ─────────────────────────────────────── -->
        <vdr-page-block>
            <div class="hulo-hero">
                <div class="hulo-hero-logo" aria-hidden="true">
                    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
                        <rect width="64" height="64" rx="14" fill="#0f1419"/>
                        <path d="M32 9 L51 16.5 V30.5 C51 43.5 43 52.5 32 56 C21 52.5 13 43.5 13 30.5 V16.5 Z" fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linejoin="round"/>
                        <rect x="21" y="27" width="22" height="15" rx="2.5" fill="none" stroke="#f59e0b" stroke-width="3"/>
                        <line x1="21" y1="32.5" x2="43" y2="32.5" stroke="#f59e0b" stroke-width="3"/>
                        <line x1="25" y1="38" x2="31" y2="38" stroke="#f59e0b" stroke-width="2.4" stroke-linecap="round"/>
                    </svg>
                </div>
                <div class="hulo-hero-text">
                    <h2 class="hulo-hero-title">Checkout Guard</h2>
                    <p class="hulo-hero-sub">The safety layer around checkout and payments: Stripe holds that actually become orders, bank transfers that expire on their own, failed and orphaned payments you can see, session-bound order lookup, rate limits and a checkout funnel.</p>
                </div>
                <div class="hulo-hero-actions">
                    <button class="gbtn gbtn-hero" (click)="helpOpen = !helpOpen" [attr.aria-expanded]="helpOpen">
                        <clr-icon shape="help"></clr-icon> Help
                    </button>
                    <button class="gbtn gbtn-hero" (click)="reloadAll()" [disabled]="loading">
                        <clr-icon shape="refresh"></clr-icon> Refresh
                    </button>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="helpOpen">
            <div class="hulo-help-drawer">
                <div class="hulo-help-grid">
                    <div class="hulo-help-card">
                        <div class="hulo-help-num">1</div>
                        <h4>Holds become orders</h4>
                        <p>A Stripe PaymentIntent created with <code class="mono">capture_method: manual</code> lands here as an <strong>Authorized</strong> payment the moment the webhook arrives. Capture it after review, or cancel it to release the customer's funds. Anything still open on day {{ safetyCaptureDays() }} is captured automatically so the authorisation never lapses.</p>
                    </div>
                    <div class="hulo-help-card">
                        <div class="hulo-help-num">2</div>
                        <h4>Bank transfers expire</h4>
                        <p>Customers who choose bank transfer get the account details and a pay-by date. Mark the payment received when the money lands; unpaid orders are cancelled after the expiry window and a reminder event fires part-way through for your email handler.</p>
                    </div>
                    <div class="hulo-help-card">
                        <div class="hulo-help-num">3</div>
                        <h4>See what went wrong</h4>
                        <p>Failed and browser-declined payments, orphaned Stripe charges from the nightly reconciliation, and settled amounts that drifted from the order total all land in Payment events. The Funnel tab shows where checkouts are lost.</p>
                    </div>
                </div>
                <div class="hulo-help-links">
                    <a href="https://huloglobal.com/vendure-plugins/checkout-guard/docs/" target="_blank">Full docs ↗</a>
                    <a href="https://huloglobal.com/vendure-plugins/checkout-guard/" target="_blank">Plugin page ↗</a>
                    <a href="mailto:support@huloglobal.com">Email support</a>
                </div>
            </div>
        </vdr-page-block>

        <!-- ── Licence & billing ───────────────────────────────────── -->
        <vdr-page-block *ngIf="meta && meta.licensed">
            <div class="update-banner" style="margin-top:8px">
                <div><strong>✅ Licensed</strong> — {{ licenceLabel() }}</div>
                <div class="actions eval-actions">
                    <ng-container *ngIf="meta.licence && !meta.licence.master && meta.licence.plan !== 'lifetime'">
                        <button class="gbtn gbtn-outline gbtn-sm" (click)="openPortal()" [disabled]="portalOpening">{{ portalOpening ? 'Opening…' : 'Manage billing ↗' }}</button>
                        <button class="gbtn gbtn-primary gbtn-sm" (click)="buyLifetime()" [disabled]="buying">{{ buying ? 'Opening checkout…' : 'Upgrade to lifetime →' }}</button>
                    </ng-container>
                    <span *ngIf="claim?.state === 'pending'" style="font-size:12.5px;font-weight:600">⏳ Waiting for checkout to finish — the licence installs itself. <a (click)="checkClaim(true)" style="cursor:pointer;text-decoration:underline">Check now</a></span>
                    <a href="https://huloglobal.com/vendure-plugins/checkout-guard/" target="_blank" class="gbtn gbtn-outline gbtn-sm">Details ↗</a>
                </div>
            </div>
            <div class="notice-strip" *ngIf="meta.notice?.message">{{ meta.notice.message }}</div>
        </vdr-page-block>
        <vdr-page-block *ngIf="meta && !meta.licensed">
            <div class="update-banner major" *ngIf="meta.tier === 'trial'">
                <div>
                    <strong>⏳ Full-featured evaluation</strong> —
                    <ng-container *ngIf="meta.eval?.daysRemaining != null; else evalNoClock">
                        <strong>{{ meta.eval.daysRemaining }} day{{ meta.eval.daysRemaining === 1 ? '' : 's' }} left</strong> with everything enabled — Stripe holds, bank-transfer auto-expiry, reconciliation, drift guard and ops alerts included.
                    </ng-container>
                    <ng-template #evalNoClock>everything is enabled — Stripe holds, bank-transfer auto-expiry, reconciliation, drift guard and ops alerts included.</ng-template>
                    Afterwards the plugin drops to the free tier.
                    <div class="banner-line" *ngIf="meta.premiumFeatures?.length"><strong>Included now:</strong> {{ meta.premiumFeatures.join(' · ') }}</div>
                    <div class="banner-line" *ngIf="meta.recentStats?.length"><strong>So far:</strong> {{ statsLine() }}</div>
                </div>
                <div class="actions eval-actions">
                    <select [(ngModel)]="buyPlan" [disabled]="buying" class="plan-select"><option value="monthly">Monthly</option><option value="annual">Annual · 2 months free</option><option value="lifetime">Lifetime · one-off</option></select>
                    <button class="gbtn gbtn-primary gbtn-sm" (click)="buyLicence()" [disabled]="buying">{{ buying ? 'Opening checkout…' : (buyPlan === 'lifetime' ? 'Buy lifetime →' : (meta?.tier === 'trial' ? 'Subscribe — first charge when the evaluation ends →' : 'Subscribe →')) }}</button>
                    <span *ngIf="claim?.state === 'pending'" style="font-size:12.5px;font-weight:600">⏳ Waiting for checkout to finish — the licence installs itself. <a (click)="checkClaim(true)" style="cursor:pointer;text-decoration:underline">Check now</a></span>
                    <a href="https://huloglobal.com/vendure-plugins/checkout-guard/" target="_blank" class="gbtn gbtn-outline gbtn-sm">Details ↗</a>
                </div>
            </div>
            <div class="update-banner" style="margin-top:8px" *ngIf="meta.tier === 'trial'">
                <div><strong>📧 Email me before it ends</strong> — one reminder a few days before the evaluation finishes, nothing else.</div>
                <div class="actions eval-actions">
                    <input class="eval-email" type="email" placeholder="you@example.com" [(ngModel)]="remindEmail" [disabled]="reminding || remindSent">
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="remindMe()" [disabled]="reminding || remindSent || !remindEmail">{{ remindSent ? 'Reminder set ✓' : (reminding ? 'Saving…' : 'Remind me') }}</button>
                </div>
            </div>
            <div class="update-banner major" *ngIf="meta.tier !== 'trial'">
                <div>
                    <strong>🔓 Free tier</strong> — session-bound order lookup, trusted client IP, rate limits, funnel events and the bank-transfer method stay active. Stripe holds, bank-transfer auto-expiry and reminders, failed-payment recording, Stripe reconciliation, the amount-drift guard and ops alerts need a licence.
                    Subscribe below (monthly or annual, cancel any time) or buy a lifetime licence.
                    <div class="banner-line" *ngIf="meta.premiumFeatures?.length"><strong>With a licence:</strong> {{ meta.premiumFeatures.join(' · ') }}</div>
                    <div class="banner-line" *ngIf="meta.recentStats?.length"><strong>{{ meta.eval?.source === 'server' ? 'During your evaluation:' : 'So far:' }}</strong> {{ statsLine() }}</div>
                </div>
                <div class="actions">
                    <select [(ngModel)]="buyPlan" [disabled]="buying" class="plan-select"><option value="monthly">Monthly</option><option value="annual">Annual (2 months free)</option><option value="lifetime">Lifetime</option></select>
                    <button class="gbtn gbtn-primary gbtn-sm" (click)="buyLicence()" [disabled]="buying">{{ buying ? 'Opening checkout…' : 'Buy licence →' }}</button>
                    <span *ngIf="claim?.state === 'pending'" style="font-size:12.5px;font-weight:600">⏳ Waiting for checkout to finish — the licence installs itself. <a (click)="checkClaim(true)" style="cursor:pointer;text-decoration:underline">Check now</a></span>
                    <a href="https://huloglobal.com/vendure-plugins/checkout-guard/" target="_blank" class="gbtn gbtn-outline gbtn-sm">Details ↗</a>
                </div>
            </div>
            <div class="update-banner" style="margin-top:8px">
                <div><strong>🔑 Already have a licence key?</strong> Paste it from your purchase email to activate instantly — no .env edit, no redeploy.</div>
                <div class="actions eval-actions">
                    <input class="eval-email" style="min-width:280px" type="text" placeholder="eyJhbGciOi…" [(ngModel)]="licenceKeyInput" [disabled]="activating">
                    <button class="gbtn gbtn-primary gbtn-sm" (click)="activateLicence()" [disabled]="activating || !licenceKeyInput">{{ activating ? 'Verifying…' : 'Activate' }}</button>
                </div>
            </div>
            <div class="notice-strip" *ngIf="meta.notice?.message">{{ meta.notice.message }}</div>
        </vdr-page-block>
        <vdr-page-block *ngIf="updateAvailable()">
            <div class="update-banner">
                <div>
                    <strong>📦 Update available</strong>
                    <!--email_off-->{{ meta.name }} {{ meta.version }} → <strong>{{ meta.update.latest }}</strong><!--/email_off-->
                </div>
                <div class="actions">
                    <a href="https://huloglobal.com/vendure-plugins/checkout-guard/changelog/" target="_blank" class="gbtn gbtn-outline gbtn-sm">What&rsquo;s new ↗</a>
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="meta.update = null">Dismiss</button>
                </div>
            </div>
        </vdr-page-block>

        <!-- ── Top bar: status sentence + tabs ─────────────────────── -->
        <vdr-page-block>
            <div class="card top-bar">
                <div class="card-block">
                    <p class="status-sentence" [class.status-off]="premiumLocked" [class.status-danger]="!premiumLocked && attentionCount() > 0">
                        {{ statusSentence() }}
                    </p>
                    <div class="tabs" role="tablist" aria-label="Checkout Guard sections">
                        <button class="tab" role="tab" [attr.aria-selected]="tab === 'overview'" [class.active]="tab === 'overview'" (click)="go('overview')">Overview</button>
                        <button class="tab" role="tab" [attr.aria-selected]="tab === 'holds'" [class.active]="tab === 'holds'" (click)="go('holds')">
                            Holds<span class="tab-count" *ngIf="kpi('holdsPending')">{{ kpi('holdsPending') }}</span>
                        </button>
                        <button class="tab" role="tab" [attr.aria-selected]="tab === 'bank'" [class.active]="tab === 'bank'" (click)="go('bank')">
                            Bank transfers<span class="tab-count" *ngIf="kpi('bankAwaiting')">{{ kpi('bankAwaiting') }}</span>
                        </button>
                        <button class="tab" role="tab" [attr.aria-selected]="tab === 'events'" [class.active]="tab === 'events'" (click)="go('events')">Payment events</button>
                        <button class="tab" role="tab" [attr.aria-selected]="tab === 'funnel'" [class.active]="tab === 'funnel'" (click)="go('funnel')">Funnel</button>
                        <button class="tab" role="tab" [attr.aria-selected]="tab === 'settings'" [class.active]="tab === 'settings'" (click)="go('settings')">Settings</button>
                    </div>
                </div>
            </div>
        </vdr-page-block>

        <!-- ============================================================ OVERVIEW -->
        <ng-container *ngIf="tab === 'overview'">
            <vdr-page-block *ngIf="setupVisible()">
                <div class="card setup-card">
                    <div class="card-block">
                        <div class="row-between">
                            <h3 class="step-title">Set-up checklist <small>{{ setupDoneCount() }} of {{ setup.items.length }} done</small></h3>
                            <a href="javascript:void(0)" class="link-more" (click)="hideSetup()">Hide</a>
                        </div>
                        <ul class="feature-list">
                            <li *ngFor="let it of setup.items; trackBy: trackByKey">
                                <span class="status-dot" [class.on]="it.done"></span>
                                <div class="setup-item">
                                    <strong>{{ it.label }}</strong>
                                    <span class="hint-inline">{{ it.hint }}</span>
                                    <a *ngIf="!it.done && it.tab" href="javascript:void(0)" class="link-more" (click)="openTab(it.tab)">Open {{ it.tab }} →</a>
                                    <a *ngIf="!it.done && it.url && it.url.startsWith('/')" class="link-more" [routerLink]="it.url">Open →</a>
                                    <a *ngIf="!it.done && it.url && !it.url.startsWith('/')" class="link-more" [href]="it.url" target="_blank">Open ↗</a>
                                </div>
                            </li>
                        </ul>
                    </div>
                </div>
            </vdr-page-block>
            <vdr-page-block>
                <div class="kpi-row">
                    <div class="kpi" [class.kpi-alert]="kpi('holdsPending') > 0">
                        <div class="kpi-label">Holds pending</div>
                        <div class="kpi-num">{{ kpi('holdsPending') }}</div>
                        <div class="kpi-sub"><a href="javascript:void(0)" (click)="go('holds')">capture or cancel →</a></div>
                    </div>
                    <div class="kpi" [class.kpi-alert]="kpi('bankAwaiting') > 0">
                        <div class="kpi-label">Bank transfers awaiting</div>
                        <div class="kpi-num">{{ kpi('bankAwaiting') }}</div>
                        <div class="kpi-sub"><a href="javascript:void(0)" (click)="go('bank')">mark received →</a></div>
                    </div>
                    <div class="kpi">
                        <div class="kpi-label">Failed payments</div>
                        <div class="kpi-num">{{ kpi('failed7d') }}</div>
                        <div class="kpi-sub">last 7 days</div>
                    </div>
                    <div class="kpi" [class.kpi-alert]="kpi('orphansOpen') > 0">
                        <div class="kpi-label">Orphaned charges</div>
                        <div class="kpi-num">{{ kpi('orphansOpen') }}</div>
                        <div class="kpi-sub">charged in Stripe, no order payment</div>
                    </div>
                    <div class="kpi" [class.kpi-alert]="kpi('drift30d') > 0">
                        <div class="kpi-label">Amount drift</div>
                        <div class="kpi-num">{{ kpi('drift30d') }}</div>
                        <div class="kpi-sub">last 30 days</div>
                    </div>
                    <div class="kpi">
                        <div class="kpi-label">Funnel drop-off</div>
                        <div class="kpi-num">{{ dropOffLabel() }}</div>
                        <div class="kpi-sub"><a href="javascript:void(0)" (click)="go('funnel')">cart → placed, 7 days →</a></div>
                    </div>
                    <div class="kpi">
                        <div class="kpi-label">Held value</div>
                        <div class="kpi-num">{{ heldValueLabel() }}</div>
                        <div class="kpi-sub">{{ usage('holdsPlaced30d') }} hold{{ usage('holdsPlaced30d') === 1 ? '' : 's' }} placed, last 30 days</div>
                    </div>
                    <div class="kpi">
                        <div class="kpi-label">Rate-limit rejections</div>
                        <div class="kpi-num">{{ usage('rateLimitRejections7d') }}</div>
                        <div class="kpi-sub">checkout mutations refused, 7 days</div>
                    </div>
                    <div class="kpi">
                        <div class="kpi-label">Denied order lookups</div>
                        <div class="kpi-num">{{ usage('orderAccessDenied7d') }}</div>
                        <div class="kpi-sub">session-bound orderByCode, 7 days</div>
                    </div>
                </div>
            </vdr-page-block>

            <vdr-page-block>
                <div class="two-col">
                    <div class="card">
                        <div class="card-block">
                            <h3 class="step-title">What is protected</h3>
                            <ul class="feature-list">
                                <li><span class="status-dot on"></span> Session-bound <code class="mono">orderByCode</code> — guests only see the order their own session placed</li>
                                <li><span class="status-dot on"></span> Trusted client IP — the forwarding header is honoured only with the proxy secret</li>
                                <li><span class="status-dot on"></span> Rate limits on coupon, payment and state-transition mutations</li>
                                <li><span class="status-dot on"></span> Checkout funnel events and browser-side decline reports</li>
                                <li><span class="status-dot on"></span> Bank-transfer payment method with account details on the order</li>
                                <li><span class="status-dot" [class.on]="!premiumLocked"></span> Stripe manual-capture holds → Authorized payments, safety capture on day {{ safetyCaptureDays() }} <span class="mini-chip" *ngIf="premiumLocked">licence required</span></li>
                                <li><span class="status-dot" [class.on]="!premiumLocked"></span> Bank-transfer auto-expiry and reminder events <span class="mini-chip" *ngIf="premiumLocked">licence required</span></li>
                                <li><span class="status-dot" [class.on]="!premiumLocked"></span> Failed-payment recording, nightly Stripe reconciliation, amount-drift guard, ops alerts <span class="mini-chip" *ngIf="premiumLocked">licence required</span></li>
                            </ul>
                        </div>
                    </div>
                    <div class="card">
                        <div class="card-block">
                            <h3 class="step-title">Recent payment events <small>last 7 days</small></h3>
                            <table class="table" *ngIf="recentEvents.length; else noRecent">
                                <thead><tr><th>When</th><th>Kind</th><th>Order</th><th>Detail</th></tr></thead>
                                <tbody>
                                    <tr *ngFor="let e of recentEvents; trackBy: trackById">
                                        <td class="nowrap">{{ e.createdAt | date: 'd MMM, HH:mm' }}</td>
                                        <td><span class="level-pill" [ngClass]="kindClass(e.kind)">{{ kindLabel(e.kind) }}</span></td>
                                        <td><a *ngIf="e.orderId" [routerLink]="['/orders', e.orderId]">{{ e.orderCode || e.orderId }}</a><span *ngIf="!e.orderId">{{ e.orderCode || '—' }}</span></td>
                                        <td class="detail-cell">{{ e.message || e.code || e.providerRef || '—' }}</td>
                                    </tr>
                                </tbody>
                            </table>
                            <ng-template #noRecent><p class="hint">Nothing recorded in the last 7 days.</p></ng-template>
                            <div style="margin-top:8px"><a href="javascript:void(0)" class="link-more" (click)="go('events')">All events →</a></div>
                        </div>
                    </div>
                </div>
            </vdr-page-block>
        </ng-container>

        <!-- ============================================================ HOLDS -->
        <ng-container *ngIf="tab === 'holds'">
            <vdr-page-block>
                <div class="card">
                    <div class="card-block">
                        <div class="row-between">
                            <h3 class="step-title">Stripe holds <small>Authorized, not yet captured</small></h3>
                            <button class="gbtn gbtn-outline gbtn-sm" (click)="loadHolds()" [disabled]="holdsLoading">{{ holdsLoading ? 'Loading…' : 'Refresh' }}</button>
                        </div>
                        <p class="hint">Funds are reserved on the customer's card until you capture or cancel. Stripe releases an authorisation after 7 days; the safety-capture cron captures anything still open after {{ safetyCaptureDays() }} days so the money is never lost. <span *ngIf="premiumLocked" class="warn-inline">Webhook handling and safety capture require a licence — holds listed here were placed while one was active.</span></p>
                        <table class="table" *ngIf="holds.length; else noHolds">
                            <thead>
                                <tr>
                                    <th>Order</th><th>Channel</th><th class="num-col">Amount</th><th>Authorised</th><th>Expires</th><th>Stripe</th><th></th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr *ngFor="let h of holds; trackBy: trackByPayment">
                                    <td><a *ngIf="h.orderId" [routerLink]="['/orders', h.orderId]">{{ h.orderCode || h.orderId }}</a><span *ngIf="!h.orderId">{{ h.orderCode || '—' }}</span></td>
                                    <td>{{ h.channelCode || '—' }}</td>
                                    <td class="num-col">{{ money(h.amount, h.currency) }}</td>
                                    <td class="nowrap">{{ h.authorisedAt ? (h.authorisedAt | date: 'd MMM, HH:mm') : '—' }}</td>
                                    <td class="nowrap">
                                        <span *ngIf="h.expiresAt" [class.exp-soon]="hoursUntil(h.expiresAt) < 24">{{ h.expiresAt | date: 'd MMM, HH:mm' }} <small>({{ relative(h.expiresAt) }})</small></span>
                                        <span *ngIf="!h.expiresAt">—</span>
                                    </td>
                                    <td class="mono small">{{ h.transactionId || '—' }}</td>
                                    <td>
                                        <div class="case-actions">
                                            <button class="gbtn gbtn-primary gbtn-sm" (click)="captureHold(h)" [disabled]="busyKey === 'hold:' + h.paymentId">{{ busyKey === 'hold:' + h.paymentId ? 'Working…' : 'Capture' }}</button>
                                            <button class="gbtn gbtn-danger gbtn-sm" (click)="cancelHold(h)" [disabled]="busyKey === 'hold:' + h.paymentId">Cancel hold</button>
                                        </div>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                        <ng-template #noHolds><p class="hint" *ngIf="!holdsLoading">No holds are waiting. Orders paid with a manual-capture PaymentIntent appear here as soon as Stripe sends <code class="mono">payment_intent.amount_capturable_updated</code>.</p></ng-template>
                    </div>
                </div>
            </vdr-page-block>
        </ng-container>

        <!-- ============================================================ BANK TRANSFERS -->
        <ng-container *ngIf="tab === 'bank'">
            <vdr-page-block>
                <div class="card">
                    <div class="card-block">
                        <div class="row-between">
                            <h3 class="step-title">Bank transfers</h3>
                            <div class="picker" style="margin:0">
                                <span class="mode-seg" role="radiogroup" aria-label="Bank transfer status">
                                    <button *ngFor="let s of bankStatuses" class="seg" role="radio" [attr.aria-checked]="bankStatus === s.key" [class.active]="bankStatus === s.key" (click)="setBankStatus(s.key)">{{ s.label }}</button>
                                </span>
                                <button class="gbtn gbtn-outline gbtn-sm" (click)="loadBank()" [disabled]="bankLoading">{{ bankLoading ? 'Loading…' : 'Refresh' }}</button>
                            </div>
                        </div>
                        <p class="hint">
                            <ng-container *ngIf="bankStatus === 'awaiting'">Orders waiting for the money to arrive. When it shows on the statement, match the reference and mark it received — the order moves to PaymentSettled and fulfilment continues. <span *ngIf="premiumLocked" class="warn-inline">Auto-expiry and reminders require a licence; without one nothing expires on its own.</span><span *ngIf="!premiumLocked">Unpaid orders are cancelled automatically after {{ bankExpiryDays() }} days.</span></ng-container>
                            <ng-container *ngIf="bankStatus === 'expired'">Orders cancelled because the transfer never arrived within {{ bankExpiryDays() }} days.</ng-container>
                            <ng-container *ngIf="bankStatus === 'settled'">Transfers you marked as received.</ng-container>
                        </p>
                        <table class="table" *ngIf="bank.length; else noBank">
                            <thead>
                                <tr>
                                    <th>Order</th><th>Reference</th><th class="num-col">Amount</th><th>Placed</th><th>Pay by</th><th>Reminder</th><th></th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr *ngFor="let b of bank; trackBy: trackByPayment">
                                    <td>
                                        <a *ngIf="b.orderId" [routerLink]="['/orders', b.orderId]">{{ b.orderCode || b.orderId }}</a><span *ngIf="!b.orderId">{{ b.orderCode || '—' }}</span>
                                        <div class="small muted" *ngIf="b.customerEmail">{{ b.customerEmail }}</div>
                                    </td>
                                    <td class="mono">{{ b.reference || b.orderCode || '—' }}</td>
                                    <td class="num-col">{{ money(b.amount, b.currency) }}</td>
                                    <td class="nowrap">{{ b.createdAt ? (b.createdAt | date: 'd MMM, HH:mm') : '—' }}</td>
                                    <td class="nowrap">
                                        <span *ngIf="b.payBy" [class.exp-soon]="bankStatus === 'awaiting' && hoursUntil(b.payBy) < 24">{{ b.payBy | date: 'd MMM' }} <small *ngIf="bankStatus === 'awaiting'">({{ relative(b.payBy) }})</small></span>
                                        <span *ngIf="!b.payBy">—</span>
                                    </td>
                                    <td class="nowrap">{{ b.reminderSentAt ? (b.reminderSentAt | date: 'd MMM') : 'not yet' }}</td>
                                    <td>
                                        <div class="case-actions" *ngIf="bankStatus === 'awaiting'">
                                            <button class="gbtn gbtn-primary gbtn-sm" (click)="bankReceived(b)" [disabled]="busyKey === 'bank:' + b.paymentId">{{ busyKey === 'bank:' + b.paymentId ? 'Working…' : 'Mark received' }}</button>
                                            <button class="gbtn gbtn-danger gbtn-sm" (click)="bankCancel(b)" [disabled]="busyKey === 'bank:' + b.paymentId">Cancel</button>
                                        </div>
                                        <span class="level-pill" *ngIf="bankStatus !== 'awaiting'" [ngClass]="bankStatus === 'settled' ? 'lvl-approved' : 'lvl-rejected'">{{ b.state || bankStatus }}</span>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                        <ng-template #noBank><p class="hint" *ngIf="!bankLoading">Nothing here.</p></ng-template>
                    </div>
                </div>
            </vdr-page-block>
        </ng-container>

        <!-- ============================================================ PAYMENT EVENTS -->
        <ng-container *ngIf="tab === 'events'">
            <vdr-page-block>
                <div class="card">
                    <div class="card-block">
                        <div class="row-between">
                            <h3 class="step-title">Payment events</h3>
                            <div class="picker" style="margin:0">
                                <select class="form-select" [(ngModel)]="eventKind" (ngModelChange)="loadEvents()">
                                    <option value="">All kinds</option>
                                    <option *ngFor="let k of eventKinds" [value]="k.key">{{ k.label }}</option>
                                </select>
                                <select class="form-select" style="min-width:120px" [(ngModel)]="eventDays" (ngModelChange)="loadEvents()">
                                    <option [ngValue]="1">Last 24 h</option>
                                    <option [ngValue]="7">Last 7 days</option>
                                    <option [ngValue]="30">Last 30 days</option>
                                    <option [ngValue]="90">Last 90 days</option>
                                </select>
                                <button class="gbtn gbtn-outline gbtn-sm" (click)="loadEvents()" [disabled]="eventsLoading">{{ eventsLoading ? 'Loading…' : 'Refresh' }}</button>
                            </div>
                        </div>
                        <p class="hint">
                            <strong>Payment failed</strong> comes from the Stripe webhook; <strong>declined in browser</strong> is reported by the storefront after an inline card decline; <strong>orphaned charge</strong> is a Stripe payment the nightly reconciliation could not match to an order; <strong>amount drift</strong> is a settled payment whose amount differs from the order total.
                            <span *ngIf="premiumLocked" class="warn-inline">Recording failed payments, reconciliation and the drift guard require a licence — only browser-declined reports are written on the free tier.</span>
                        </p>
                        <table class="table" *ngIf="events.length; else noEvents">
                            <thead>
                                <tr><th>When</th><th>Kind</th><th>Order</th><th>Provider</th><th>Code</th><th>Message</th><th class="num-col">Amount</th><th>IP</th></tr>
                            </thead>
                            <tbody>
                                <tr *ngFor="let e of events; trackBy: trackById">
                                    <td class="nowrap">{{ e.createdAt | date: 'd MMM, HH:mm' }}</td>
                                    <td><span class="level-pill" [ngClass]="kindClass(e.kind)">{{ kindLabel(e.kind) }}</span></td>
                                    <td><a *ngIf="e.orderId" [routerLink]="['/orders', e.orderId]">{{ e.orderCode || e.orderId }}</a><span *ngIf="!e.orderId">{{ e.orderCode || '—' }}</span></td>
                                    <td class="nowrap">{{ e.provider || '—' }}<div class="mono small muted" *ngIf="e.providerRef">{{ e.providerRef }}</div></td>
                                    <td class="mono small">{{ e.code || '—' }}</td>
                                    <td class="detail-cell">{{ e.message || '—' }}</td>
                                    <td class="num-col">{{ e.amountMinor != null ? money(e.amountMinor, e.currency) : '—' }}</td>
                                    <td class="mono small">{{ e.ip || '—' }}</td>
                                </tr>
                            </tbody>
                        </table>
                        <ng-template #noEvents><p class="hint" *ngIf="!eventsLoading">No events match this filter.</p></ng-template>
                    </div>
                </div>
            </vdr-page-block>
        </ng-container>

        <!-- ============================================================ FUNNEL -->
        <ng-container *ngIf="tab === 'funnel'">
            <vdr-page-block>
                <div class="card">
                    <div class="card-block">
                        <div class="row-between">
                            <h3 class="step-title">Checkout funnel</h3>
                            <div class="picker" style="margin:0">
                                <select class="form-select" style="min-width:120px" [(ngModel)]="funnelDays" (ngModelChange)="loadFunnel()">
                                    <option [ngValue]="1">Last 24 h</option>
                                    <option [ngValue]="7">Last 7 days</option>
                                    <option [ngValue]="30">Last 30 days</option>
                                    <option [ngValue]="90">Last 90 days</option>
                                </select>
                                <button class="gbtn gbtn-outline gbtn-sm" (click)="loadFunnel()" [disabled]="funnelLoading">{{ funnelLoading ? 'Loading…' : 'Refresh' }}</button>
                            </div>
                        </div>
                        <p class="hint">Each step is a distinct checkout session reported by the storefront's <code class="mono">POST /checkout-guard/funnel</code> calls. Drop-off is measured against the previous step. Payment failures and coupon rejections are side events — they do not sit in the chain.</p>
                        <table class="table" *ngIf="funnel.length; else noFunnel">
                            <thead><tr><th>Step</th><th class="num-col">Sessions</th><th style="width:40%">Share of cart</th><th class="num-col">Drop-off</th></tr></thead>
                            <tbody>
                                <tr *ngFor="let s of funnel">
                                    <td>{{ s.label }} <span class="mini-chip" *ngIf="isSideStep(s.step)">side event</span></td>
                                    <td class="num-col">{{ s.count }}</td>
                                    <td>
                                        <span class="mini-track" *ngIf="!isSideStep(s.step)"><span class="mini-fill" [style.width.%]="s.sharePct"></span></span>
                                    </td>
                                    <td class="num-col" [class.drop-bad]="s.dropOffPct != null && s.dropOffPct >= 50">{{ s.dropOffPct == null ? '—' : (s.dropOffPct | number: '1.0-1') + '%' }}</td>
                                </tr>
                            </tbody>
                        </table>
                        <ng-template #noFunnel><p class="hint" *ngIf="!funnelLoading">No funnel events yet. Wire the storefront to post <code class="mono">{{ '{' }} step, orderCode {{ '}' }}</code> to <code class="mono">/checkout-guard/funnel</code> for the steps cart, address, payment, pay_attempt, pay_failed, coupon_rejected and placed.</p></ng-template>
                    </div>
                </div>
            </vdr-page-block>
        </ng-container>

        <!-- ============================================================ SETTINGS -->
        <ng-container *ngIf="tab === 'settings'">
            <vdr-page-block>
                <div class="card">
                    <div class="card-block">
                        <h3 class="step-title">Effective configuration <small>read-only</small></h3>
                        <p class="hint">Checkout Guard is configured in code — the plugin options in <code class="mono">vendure-config.ts</code> plus a few environment variables. Secrets are never shown here, only whether they are set.</p>
                        <ng-container *ngIf="settingsSections.length; else noSettings">
                            <div class="settings-grid">
                                <div class="settings-section" *ngFor="let sec of settingsSections">
                                    <div class="subsection-title">{{ sec.title }}</div>
                                    <table class="table kv">
                                        <tbody>
                                            <tr *ngFor="let r of sec.rows"><td class="kv-key">{{ r.key }}</td><td class="mono">{{ r.value }}</td></tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </ng-container>
                        <ng-template #noSettings>
                            <p class="hint" *ngIf="settingsError">{{ settingsError }}</p>
                            <p class="hint" *ngIf="!settingsError && !settingsLoading">No settings were returned.</p>
                        </ng-template>
                    </div>
                </div>
            </vdr-page-block>
            <vdr-page-block>
                <div class="card">
                    <div class="card-block">
                        <h3 class="step-title">How to configure</h3>
                        <p class="hint">Register the plugin with the options you need. Every option is optional except <code class="mono">publicBaseUrl</code>.</p>
<pre class="code-block">{{ configExample }}</pre>
                        <p class="hint">The set-up checklist (webhook secret, payment methods, trusted proxy, ops channel) is on the <a href="javascript:void(0)" (click)="go('overview')">Overview</a> tab. Remember to set <code class="mono">orderOptions.orderByCodeAccessStrategy = new SessionBoundOrderByCodeAccessStrategy('2h')</code> in the host config — the plugin cannot check that for you.</p>
                    </div>
                </div>
            </vdr-page-block>
            <vdr-page-block>
                <div class="card">
                    <div class="card-block">
                        <h3 class="step-title">Weekly report <small>Monday 08:00, server time</small></h3>
                        <p class="hint">One e-mail a week with what Checkout Guard did for your store — holds placed and captured, held value, bank transfers confirmed, rate-limited abuse, orphaned charges — and the next set-up step. It is sent through the host's <code class="mono">SMTP_SERVER</code> / <code class="mono">SMTP_USER</code> / <code class="mono">SMTP_PASSWORD</code> settings, the same ones the ops e-mails use.</p>
                        <ng-container *ngIf="digest; else digestLoading">
                            <div class="digest-row">
                                <label class="digest-toggle"><input type="checkbox" [(ngModel)]="digest.enabled" (ngModelChange)="saveDigest({ enabled: $event })" [disabled]="digestSaving"> Send the weekly report</label>
                                <input class="form-input" type="email" [(ngModel)]="digestRecipient" [placeholder]="digest.defaultRecipient ? 'Defaults to ' + digest.defaultRecipient : 'Recipient e-mail'" [disabled]="digestSaving" style="min-width:260px">
                                <button class="gbtn gbtn-outline gbtn-sm" (click)="saveDigest({ recipient: digestRecipient })" [disabled]="digestSaving">{{ digestSaving ? 'Saving…' : 'Save recipient' }}</button>
                                <button class="gbtn gbtn-primary gbtn-sm" (click)="sendDigestTest()" [disabled]="digestSending">{{ digestSending ? 'Sending…' : 'Send me a test' }}</button>
                                <button class="gbtn gbtn-outline gbtn-sm" (click)="previewDigest()" [disabled]="digestPreviewing">{{ digestPreviewing ? 'Opening…' : 'Preview' }}</button>
                            </div>
                            <p class="hint">
                                Last sent {{ digest.lastSentAt ? (digest.lastSentAt | date: 'd MMM yyyy, HH:mm') : 'never' }} · next {{ digest.nextDueAt ? (digest.nextDueAt | date: 'd MMM yyyy, HH:mm') : (digest.enabled ? '—' : 'off') }}
                                <span *ngIf="digest.enabled && !digest.recipient && !digest.defaultRecipient"> · <span class="warn-inline">no recipient yet — set <code class="mono">ops.adminEmail</code> or enter one above</span></span>
                            </p>
                        </ng-container>
                        <ng-template #digestLoading><p class="hint">{{ digestError || 'Loading…' }}</p></ng-template>
                    </div>
                </div>
            </vdr-page-block>
            <vdr-page-block>
                <div class="card">
                    <div class="card-block">
                        <h3 class="step-title">Endpoints</h3>
                        <table class="table">
                            <thead><tr><th>Route</th><th>Who</th><th>Purpose</th></tr></thead>
                            <tbody>
                                <tr><td class="mono small">POST /checkout-guard/stripe-webhook</td><td>Stripe</td><td>Signed webhook — turns manual-capture intents into Authorized payments, records failures</td></tr>
                                <tr><td class="mono small">POST /checkout-guard/funnel</td><td>Storefront</td><td>Funnel step events (rate-limited)</td></tr>
                                <tr><td class="mono small">POST /checkout-guard/client-decline</td><td>Storefront</td><td>Inline card declines seen in the browser (rate-limited)</td></tr>
                                <tr><td class="mono small">GET /checkout-guard/holds · POST …/:paymentId/capture | cancel</td><td>Admin</td><td>This page's Holds tab</td></tr>
                                <tr><td class="mono small">GET /checkout-guard/bank-transfers · POST …/:paymentId/received | cancel</td><td>Admin</td><td>This page's Bank transfers tab</td></tr>
                                <tr><td class="mono small">GET /checkout-guard/events · /summary · /funnel/summary</td><td>Admin</td><td>Overview, events and funnel</td></tr>
                                <tr><td class="mono small">GET /checkout-guard/setup · /widget</td><td>Admin</td><td>Set-up checklist and the dashboard widget</td></tr>
                                <tr><td class="mono small">GET|POST /checkout-guard/digest/settings · POST …/send-test · GET …/preview</td><td>Admin</td><td>Weekly report</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </vdr-page-block>
            <vdr-page-block>
                <div class="card">
                    <div class="card-block">
                        <h3 class="step-title">About</h3>
                        <p class="hint" *ngIf="meta">
                            <!--email_off-->{{ meta.name }} v{{ meta.version }}<!--/email_off--> ·
                            Licence: <strong>{{ meta.licensed ? '✓ active' : (meta.tier === 'trial' ? 'evaluation' : 'free tier') }}</strong>
                            <span *ngIf="!meta.licensed && meta.licenceMessage"> — {{ meta.licenceMessage }}</span>
                        </p>
                        <p class="hint">Crons: safety capture hourly · bank-transfer expiry every 6 hours · Stripe reconciliation daily at 04:10. All run on the worker.</p>
                    </div>
                </div>
            </vdr-page-block>
        </ng-container>
    `,
    styles: [`
        :host { display: block; color: var(--gb-strong); }

        /* ── Verified theme tokens (HULO admin design system) ─────────
           Same machine-checked token set as fraud-prevention — every
           text/surface pair >= 4.5:1 and every control boundary >= 3:1
           against the real admin theme values, both themes. */
        :host {
            --gb-surface: var(--color-component-bg-100, #fafafa);
            --gb-surface-2: var(--color-component-bg-200, #f2f3f5);
            --gb-line: var(--color-component-border-200, #d5d8de);
            --gb-line-soft: var(--color-component-border-100, #e8eaee);
            --gb-strong: #3d4147;
            --gb-muted: #5d6470;
            --gb-ui-border: #79818f;
            --gb-amber: #f59e0b;
            --gb-amber-hover: #e18f06;
            --gb-amber-edge: #b45309;
            --gb-amber-ink: #231602;
            --gb-danger-ink: #b91c1c;
            --gb-ok: #10b981; --gb-warn: #f59e0b; --gb-bad: #ef4444; --gb-info: #3b82f6;
            --gb-blue: #2a78d6;
            --gb-tint-ok:   color-mix(in srgb, var(--gb-ok) 10%, var(--gb-surface));
            --gb-tint-warn: color-mix(in srgb, var(--gb-warn) 12%, var(--gb-surface));
            --gb-tint-bad:  color-mix(in srgb, var(--gb-bad) 10%, var(--gb-surface));
            --gb-tint-info: color-mix(in srgb, var(--gb-info) 10%, var(--gb-surface));
            --gb-line-ok:   color-mix(in srgb, var(--gb-ok) 45%, transparent);
            --gb-line-warn: color-mix(in srgb, var(--gb-warn) 50%, transparent);
            --gb-line-bad:  color-mix(in srgb, var(--gb-bad) 45%, transparent);
            --gb-line-info: color-mix(in srgb, var(--gb-info) 45%, transparent);
            --gb-shadow-1: 0 1px 2px rgba(15, 23, 42, 0.06);
        }
        :host-context([data-theme='dark']) {
            --gb-strong: var(--color-text-100, hsl(210, 16%, 93%));
            --gb-muted: hsl(205, 14%, 74%);
            --gb-ui-border: hsl(203, 12%, 50%);
            --gb-amber-edge: #f59e0b;
            --gb-danger-ink: #f87171;
            --gb-blue: #3987e5;
            --gb-shadow-1: 0 1px 2px rgba(0, 0, 0, 0.35);
        }

        /* ── Buttons (self-owned) ─────────────────────────────────── */
        .gbtn {
            display: inline-flex; align-items: center; justify-content: center; gap: 6px;
            min-height: 36px; padding: 0 16px; border-radius: 8px;
            font-size: 13px; font-weight: 600; line-height: 1.2; white-space: nowrap;
            border: 1px solid transparent; background: none; cursor: pointer;
            color: var(--gb-strong); text-decoration: none;
            transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease, box-shadow 0.12s ease;
        }
        .gbtn:disabled { opacity: 0.45; cursor: not-allowed; }
        .gbtn:focus-visible, .tab:focus-visible, .seg:focus-visible {
            outline: 2px solid var(--gb-amber-edge); outline-offset: 2px;
        }
        .gbtn-sm { min-height: 30px; padding: 0 12px; font-size: 12px; }
        .gbtn-primary { background: var(--gb-amber); border-color: var(--gb-amber-edge); color: var(--gb-amber-ink); box-shadow: var(--gb-shadow-1); }
        .gbtn-primary:hover:not(:disabled) { background: var(--gb-amber-hover); }
        .gbtn-outline { border-color: var(--gb-ui-border); background: var(--gb-surface); }
        .gbtn-outline:hover:not(:disabled) { border-color: var(--gb-amber-edge); background: var(--gb-surface-2); }
        .gbtn-ghost { color: var(--gb-muted); }
        .gbtn-ghost:hover:not(:disabled) { color: var(--gb-strong); background: var(--gb-surface-2); }
        .gbtn-danger { color: var(--gb-danger-ink); }
        .gbtn-danger:hover:not(:disabled) { color: var(--gb-danger-ink); background: var(--gb-tint-bad); }
        .gbtn-hero { color: #e2e8f0; }
        .gbtn-hero:hover:not(:disabled) { color: #ffffff; background: rgba(255, 255, 255, 0.12); }
        .gbtn-hero:focus-visible { outline-color: #f59e0b; }

        /* ── Hero ─────────────────────────────────────────────────── */
        .hulo-hero {
            display: flex; align-items: center; gap: 18px;
            padding: 20px 22px; border-radius: 14px;
            background: linear-gradient(135deg, #0f1419 0%, #1e293b 100%);
            color: #fff;
            box-shadow: 0 1px 3px rgba(15, 23, 42, 0.15), 0 8px 24px rgba(15, 23, 42, 0.08);
        }
        .hulo-hero-logo { flex: 0 0 auto; width: 56px; height: 56px; }
        .hulo-hero-logo svg { width: 100%; height: 100%; display: block; }
        .hulo-hero-text { flex: 1 1 auto; min-width: 0; }
        .hulo-hero-title { color: #fff; font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
        .hulo-hero-sub { color: #cbd5e1; font-size: 13px; line-height: 1.5; margin: 4px 0 0; max-width: 720px; }
        .hulo-hero-actions { display: flex; gap: 6px; align-items: center; flex: 0 0 auto; }

        /* ── Help drawer ──────────────────────────────────────────── */
        .hulo-help-drawer { background: var(--gb-tint-warn); border: 1px solid var(--gb-line-warn); border-radius: 12px; padding: 20px 22px; color: var(--gb-strong); }
        .hulo-help-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
        .hulo-help-card { background: var(--gb-surface); border-radius: 10px; padding: 16px; border: 1px solid var(--gb-line); }
        .hulo-help-num { width: 24px; height: 24px; border-radius: 999px; background: var(--gb-amber); color: var(--gb-amber-ink); font-weight: 800; font-size: 13px; display: grid; place-items: center; margin-bottom: 8px; }
        .hulo-help-card h4 { margin: 0 0 4px; font-size: 14px; color: var(--gb-strong); }
        .hulo-help-card p { margin: 0; font-size: 13px; line-height: 1.5; color: var(--gb-muted); }
        .hulo-help-links { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--gb-line-warn); display: flex; gap: 18px; flex-wrap: wrap; font-size: 13px; }
        .hulo-help-links a { color: var(--gb-strong); text-decoration: underline; text-underline-offset: 2px; font-weight: 600; }
        .hulo-help-links a:hover { color: var(--gb-amber-edge); }

        /* ── Cards + layout ───────────────────────────────────────── */
        .card { background: var(--gb-surface); border: 1px solid var(--gb-line); border-radius: 12px; overflow: visible; min-width: 0; box-shadow: var(--gb-shadow-1); }
        .card-block { padding: 18px 20px; }
        .two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
        .row-between { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
        .step-title { font-size: 15px; font-weight: 700; color: var(--gb-strong); margin: 0 0 4px; }
        .step-title small { font-weight: 500; font-size: 12px; color: var(--gb-muted); }
        .hint { font-size: 12px; color: var(--gb-muted); margin: 2px 0 12px; line-height: 1.5; }
        .mono { font-family: ui-monospace, monospace; }
        .small { font-size: 11.5px; }
        .muted { color: var(--gb-muted); }
        .nowrap { white-space: nowrap; }
        .warn-inline { color: var(--gb-amber-edge); font-weight: 600; }
        .link-more { color: var(--gb-amber-edge); font-weight: 600; font-size: 12.5px; text-decoration: none; }
        .link-more:hover { text-decoration: underline; }
        .feature-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: var(--gb-strong); }
        .feature-list li { display: flex; align-items: flex-start; gap: 10px; line-height: 1.45; }
        .feature-list .status-dot { margin-top: 5px; }
        .code-block {
            margin: 0 0 14px; padding: 14px 16px; border-radius: 10px; overflow-x: auto;
            background: var(--gb-surface-2); border: 1px solid var(--gb-line);
            color: var(--gb-strong); font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.55;
        }

        /* ── Top bar ──────────────────────────────────────────────── */
        .top-bar { border-left: 4px solid var(--gb-amber); }
        .lbl { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--gb-muted); }
        .form-select, .form-input {
            padding: 7px 10px; border-radius: 8px; min-height: 36px;
            border: 1px solid var(--gb-ui-border); background: var(--gb-surface);
            color: var(--gb-strong); font-size: 13px;
        }
        .form-select { min-width: 160px; }
        .form-select:focus, .form-input:focus {
            outline: none; border-color: var(--gb-amber-edge);
            box-shadow: 0 0 0 3px color-mix(in srgb, var(--gb-amber) 30%, transparent);
        }
        .plan-select { padding: 5px 9px; border: 1px solid #d1d5db; border-radius: 7px; font-size: 12.5px; background: #fff; color: #0f172a; }
        .mode-seg { display: inline-flex; border: 1px solid var(--gb-ui-border); border-radius: 999px; overflow: hidden; }
        .seg {
            padding: 7px 14px; min-height: 34px; border: 0; background: none; cursor: pointer;
            font-size: 12px; font-weight: 700; color: var(--gb-muted);
        }
        .seg + .seg { border-left: 1px solid var(--gb-line); }
        .seg:hover { color: var(--gb-strong); background: var(--gb-surface-2); }
        .seg.active { background: var(--gb-amber); color: var(--gb-amber-ink); }
        .status-sentence {
            margin: 0; padding: 10px 14px; border-radius: 8px;
            font-size: 13px; line-height: 1.5; color: var(--gb-strong);
            background: var(--gb-tint-ok); border: 1px solid var(--gb-line-ok); border-left-width: 4px;
        }
        .status-sentence.status-off { background: var(--gb-surface-2); border-color: var(--gb-line); color: var(--gb-muted); }
        .status-sentence.status-danger { background: var(--gb-tint-warn); border-color: var(--gb-line-warn); font-weight: 600; }
        .tabs { display: flex; gap: 4px; margin-top: 14px; flex-wrap: wrap; border-top: 1px solid var(--gb-line-soft); padding-top: 12px; }
        .tab {
            display: inline-flex; align-items: center; gap: 6px;
            padding: 7px 14px; min-height: 34px; border-radius: 999px;
            border: 1px solid transparent; background: none; cursor: pointer;
            font-size: 13px; font-weight: 600; color: var(--gb-muted);
            transition: background 0.12s ease, color 0.12s ease;
        }
        .tab:hover { color: var(--gb-strong); background: var(--gb-surface-2); }
        .tab.active { background: var(--gb-amber); border-color: var(--gb-amber-edge); color: var(--gb-amber-ink); }
        .tab-count {
            font-size: 10px; font-weight: 800; min-width: 16px; height: 16px;
            padding: 0 4px; border-radius: 999px; display: inline-grid; place-items: center;
            background: color-mix(in srgb, currentColor 18%, transparent);
        }

        /* ── KPI tiles ────────────────────────────────────────────── */
        .kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
        .kpi { background: var(--gb-surface); border: 1px solid var(--gb-line); border-radius: 12px; padding: 16px 18px; min-width: 0; }
        .kpi-alert { border-color: var(--gb-line-warn); border-left: 4px solid var(--gb-amber); }
        .kpi-label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--gb-muted); }
        .kpi-num { margin-top: 6px; font-size: 26px; font-weight: 700; line-height: 1.1; color: var(--gb-strong); font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
        .kpi-sub { margin-top: 4px; font-size: 12px; color: var(--gb-muted); }
        .kpi-sub a { color: var(--gb-amber-edge); font-weight: 600; text-decoration: none; }
        .kpi-sub a:hover { text-decoration: underline; }

        /* ── Pills + chips ────────────────────────────────────────── */
        .level-pill {
            font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 999px; white-space: nowrap;
            color: var(--gb-strong); border: 1px solid var(--gb-line); background: var(--gb-surface-2);
        }
        .lvl-info { background: var(--gb-tint-info); border-color: var(--gb-line-info); }
        .lvl-warn { background: var(--gb-tint-warn); border-color: var(--gb-line-warn); }
        .lvl-bad, .lvl-rejected { background: var(--gb-tint-bad); border-color: var(--gb-line-bad); }
        .lvl-approved { background: var(--gb-tint-ok); border-color: var(--gb-line-ok); }
        .mini-chip {
            font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 5px;
            background: var(--gb-surface); border: 1px solid var(--gb-line-warn);
            color: var(--gb-strong); margin: 1px; display: inline-block; vertical-align: middle;
        }
        .exp-soon { color: var(--gb-danger-ink); font-weight: 700; }
        .drop-bad { color: var(--gb-danger-ink); font-weight: 700; }

        /* ── Tables ───────────────────────────────────────────────── */
        .table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .table th {
            text-align: left; font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
            text-transform: uppercase; color: var(--gb-muted);
            padding: 8px 10px; border-bottom: 1px solid var(--gb-line);
        }
        .table td { padding: 9px 10px; border-bottom: 1px solid var(--gb-line-soft); color: var(--gb-strong); vertical-align: top; }
        .table tbody tr:hover { background: var(--gb-surface-2); }
        .table td a { color: var(--gb-blue); font-weight: 600; text-decoration: none; }
        .table td a:hover { text-decoration: underline; }
        .table .num-col { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .table th.num-col { text-align: right; }
        .table.kv td { padding: 6px 8px; font-size: 12.5px; }
        .table.kv .kv-key { color: var(--gb-muted); white-space: nowrap; width: 42%; }
        .detail-cell { max-width: 320px; overflow-wrap: anywhere; }
        .mini-track { display: inline-block; height: 8px; width: 100%; max-width: 320px; background: var(--gb-surface-2); border-radius: 999px; overflow: hidden; vertical-align: middle; }
        .mini-fill { display: block; height: 100%; background: var(--gb-amber); border-radius: 999px; }
        .case-actions { display: flex; gap: 6px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
        .picker { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
        .status-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--gb-ui-border); flex: 0 0 auto; display: inline-block; }
        .status-dot.on { background: var(--gb-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--gb-ok) 25%, transparent); }

        .subsection-title {
            margin: 20px 0 10px; font-size: 11px; font-weight: 700;
            letter-spacing: 0.06em; text-transform: uppercase; color: var(--gb-muted);
        }
        .settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 0 24px; }
        .settings-section .subsection-title { margin-top: 8px; }

        /* ── Banners ──────────────────────────────────────────────── */
        .update-banner {
            display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap;
            padding: 12px 16px; border-radius: 10px; font-size: 13px; color: var(--gb-strong);
            background: var(--gb-tint-info); border: 1px solid var(--gb-line-info);
        }
        .update-banner.major { background: var(--gb-tint-warn); border-color: var(--gb-line-warn); }
        .update-banner .actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
        .eval-actions { align-items: center; }
        .eval-email { padding: 5px 9px; border: 1px solid var(--gb-ui-border); border-radius: 7px; font-size: 12.5px; min-width: 190px; background: #fff; color: #0f172a; }
        .banner-line { margin-top: 6px; font-size: 12.5px; color: var(--gb-strong); line-height: 1.45; }
        .notice-strip {
            margin-top: 8px; padding: 10px 14px; border-radius: 8px; font-size: 13px; line-height: 1.5;
            background: var(--gb-tint-warn); border: 1px solid var(--gb-line-warn); border-left: 4px solid var(--gb-amber); color: var(--gb-strong);
        }

        /* ── Set-up checklist + weekly report ─────────────────────── */
        .setup-card { border-left: 4px solid var(--gb-amber); }
        .setup-item { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .hint-inline { font-size: 12px; color: var(--gb-muted); line-height: 1.45; }
        .digest-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 4px 0 8px; }
        .digest-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: var(--gb-strong); margin-right: 6px; cursor: pointer; }

        @media (prefers-reduced-motion: reduce) {
            .gbtn, .tab, .seg { transition: none; }
        }
        @media (max-width: 640px) {
            .hulo-hero { flex-wrap: wrap; }
            .hulo-hero-actions { width: 100%; justify-content: flex-end; }
            .form-select { min-width: 0; flex: 1; }
            .two-col { grid-template-columns: 1fr; }
        }
    `],
})
export class CheckoutGuardComponent implements OnInit, OnDestroy {
    loading = true;
    helpOpen = false;
    tab: Tab = 'overview';

    meta: any = null;
    premiumLocked = false;
    summary: any = null;
    recentEvents: EventRow[] = [];

    holds: HoldRow[] = [];
    holdsLoading = false;

    bank: BankRow[] = [];
    bankLoading = false;
    bankStatus: BankStatus = 'awaiting';
    bankStatuses: Array<{ key: BankStatus; label: string }> = [
        { key: 'awaiting', label: 'Awaiting' },
        { key: 'expired', label: 'Expired' },
        { key: 'settled', label: 'Settled' },
    ];

    events: EventRow[] = [];
    eventsLoading = false;
    eventKind = '';
    eventDays = 7;
    eventKinds = EVENT_KINDS;

    funnel: FunnelStep[] = [];
    funnelLoading = false;
    funnelDays = 7;

    settings: any = null;
    settingsSections: SettingsSection[] = [];
    settingsLoading = false;
    settingsError = '';

    /** Set-up checklist (Overview). Hidden by the admin only while every item is done. */
    setup: { items: SetupItemRow[]; complete: boolean } | null = null;
    private setupHidden = false;

    /** Trial reminder ("Email me before it ends"). */
    remindEmail = '';
    reminding = false;
    remindSent = false;

    /** Weekly report card (Settings). */
    digest: DigestSettings | null = null;
    digestRecipient = '';
    digestSaving = false;
    digestSending = false;
    digestPreviewing = false;
    digestError = '';

    /** Rendered through interpolation: Angular would otherwise read the braces as ICU expressions. */
    readonly configExample = `CheckoutGuardPlugin.init({
    publicBaseUrl: 'https://shop.example.com',
    licenceKey: process.env.CHECKOUT_GUARD_LICENCE_KEY,
    stripe: {
        webhookSecret: process.env.STRIPE_CG_WEBHOOK_SECRET,   // per channel: STRIPE_CG_WEBHOOK_SECRET_<CHANNELCODE>
        holdMethodCode: 'stripe-hold',
        safetyCaptureDays: 6,
        autoCaptureBelowMinor: undefined,
    },
    bankTransfer: { expiryDays: 7, reminderAfterDays: 3 },
    reconciliation: { enabled: true, lookbackDays: 3 },
    trustedClientIp: {
        header: 'x-real-client-ip',
        secretHeader: 'x-checkout-guard-proxy',
        secret: process.env.CHECKOUT_GUARD_PROXY_SECRET,
        trustedProxies: ['10.0.0.0/8'],   // proxies allowed to set x-forwarded-for / cf-connecting-ip
    },
    rateLimits: { mutations: { applyCouponCode: { capacity: 10, windowMs: 60000 } } },
    ops: { slackWebhookUrl: process.env.OPS_SLACK_WEBHOOK, adminEmail: 'ops@example.com' },
    orderAccess: { anonymousAccessDuration: '2h' },
})`;

    /** `<scope>:<paymentId>` of the row whose action is in flight. */
    busyKey = '';

    /** Every HTTP/modal subscription, torn down on destroy so a late response never touches a dead view. */
    private readonly subs = new Subscription();

    constructor(
        private http: HttpClient,
        private notification: NotificationService,
        private modal: ModalService,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnInit() {
        try { this.setupHidden = localStorage.getItem(SETUP_HIDDEN_KEY) === '1'; } catch { this.setupHidden = false; }
        this.checkClaim(false);
        this.reloadAll();
    }

    ngOnDestroy() { this.stopClaimPoll(); this.subs.unsubscribe(); }

    // ── Loading ──────────────────────────────────────────────────────

    reloadAll() {
        this.loading = true;
        // Settings only change with a server restart: cached after the first
        // load, and only this button (or a re-open) fetches them again.
        this.settings = null;
        this.loadMeta();
        this.loadSummary();
        this.loadRecentEvents();
        this.loadSetup();
        this.loadTab(this.tab);
    }

    go(tab: Tab) {
        this.tab = tab;
        this.loadTab(tab);
        this.cdr.markForCheck();
    }

    private loadTab(tab: Tab) {
        if (tab === 'holds') this.loadHolds();
        else if (tab === 'bank') this.loadBank();
        else if (tab === 'events') this.loadEvents();
        else if (tab === 'funnel') this.loadFunnel();
        else if (tab === 'settings') this.loadSettings();
    }

    private loadMeta() {
        this.subs.add(this.http.get<any>(`${API}/meta`).subscribe({
            next: m => { this.meta = m; this.premiumLocked = !!m && m.tier === 'free'; this.cdr.markForCheck(); },
            error: () => undefined,
        }));
    }

    loadSummary() {
        this.subs.add(this.http.get<any>(`${API}/summary`).subscribe({
            next: s => { this.summary = s || {}; this.loading = false; this.cdr.markForCheck(); },
            error: e => { this.loading = false; this.notification.error(this.errMsg(e, 'Could not load the summary')); this.cdr.markForCheck(); },
        }));
    }

    private loadRecentEvents() {
        this.subs.add(this.http.get<any>(`${API}/events`, { params: { days: '7', limit: '8' } }).subscribe({
            next: r => { this.recentEvents = this.asList<EventRow>(r, 'events', 'items').slice(0, 8); this.cdr.markForCheck(); },
            error: () => undefined,
        }));
    }

    loadHolds() {
        this.holdsLoading = true;
        this.subs.add(this.http.get<any>(`${API}/holds`).subscribe({
            next: r => { this.holds = this.asList<HoldRow>(r, 'items', 'holds').map((h: any) => ({ ...h, currency: h.currency ?? h.currencyCode, transactionId: h.transactionId ?? h.paymentIntentId })); this.holdsLoading = false; this.cdr.markForCheck(); },
            error: e => { this.holdsLoading = false; this.notification.error(this.errMsg(e, 'Could not load holds')); this.cdr.markForCheck(); },
        }));
    }

    setBankStatus(s: BankStatus) { this.bankStatus = s; this.loadBank(); }

    loadBank() {
        this.bankLoading = true;
        this.subs.add(this.http.get<any>(`${API}/bank-transfers`, { params: { status: this.bankStatus } }).subscribe({
            next: r => { this.bank = this.asList<BankRow>(r, 'rows', 'transfers', 'bankTransfers', 'items').map((b: any) => ({ ...b, amount: b.amount ?? b.amountMinor, reference: b.reference ?? b.orderCode, state: b.state ?? b.paymentState })); this.bankLoading = false; this.cdr.markForCheck(); },
            error: e => { this.bankLoading = false; this.notification.error(this.errMsg(e, 'Could not load bank transfers')); this.cdr.markForCheck(); },
        }));
    }

    loadEvents() {
        this.eventsLoading = true;
        const params: Record<string, string> = { days: String(this.eventDays) };
        if (this.eventKind) params.kind = this.eventKind;
        this.subs.add(this.http.get<any>(`${API}/events`, { params }).subscribe({
            next: r => { this.events = this.asList<EventRow>(r, 'events', 'items'); this.eventsLoading = false; this.cdr.markForCheck(); },
            error: e => { this.eventsLoading = false; this.notification.error(this.errMsg(e, 'Could not load payment events')); this.cdr.markForCheck(); },
        }));
    }

    loadFunnel() {
        this.funnelLoading = true;
        this.subs.add(this.http.get<any>(`${API}/funnel/summary`, { params: { days: String(this.funnelDays) } }).subscribe({
            next: r => { this.funnel = this.normaliseFunnel(r); this.funnelLoading = false; this.cdr.markForCheck(); },
            error: e => { this.funnelLoading = false; this.notification.error(this.errMsg(e, 'Could not load the funnel')); this.cdr.markForCheck(); },
        }));
    }

    loadSettings() {
        this.loadDigest();
        if (this.settings && !this.settingsError) { this.cdr.markForCheck(); return; }
        this.settingsLoading = true;
        this.settingsError = '';
        this.subs.add(this.http.get<any>(`${API}/settings`).subscribe({
            next: s => { this.settings = s || {}; this.settingsSections = this.buildSettingsSections(this.settings); this.settingsLoading = false; this.cdr.markForCheck(); },
            error: e => {
                this.settingsLoading = false;
                this.settings = null;
                this.settingsSections = [];
                this.settingsError = e?.status === 404
                    ? 'This server does not expose its effective settings yet — check vendure-config.ts directly.'
                    : this.errMsg(e, 'Could not load the settings');
                this.cdr.markForCheck();
            },
        }));
    }

    // ── Set-up checklist ─────────────────────────────────────────────

    private loadSetup() {
        this.subs.add(this.http.get<any>(`${API}/setup`).subscribe({
            next: r => { this.setup = r && Array.isArray(r.items) ? { items: r.items, complete: !!r.complete } : null; this.cdr.markForCheck(); },
            error: () => undefined,
        }));
    }

    /** Shown while something is undone; once complete it stays only until the admin hides it. */
    setupVisible(): boolean {
        if (!this.setup || !this.setup.items.length) return false;
        if (!this.setup.complete) return true;
        return !this.setupHidden;
    }

    setupDoneCount(): number { return this.setup ? this.setup.items.filter(i => i.done).length : 0; }

    hideSetup() {
        this.setupHidden = true;
        try { localStorage.setItem(SETUP_HIDDEN_KEY, '1'); } catch { /* private mode */ }
        this.cdr.markForCheck();
    }

    openTab(tab: string) {
        if (tab === 'overview' || tab === 'holds' || tab === 'bank' || tab === 'events' || tab === 'funnel' || tab === 'settings') this.go(tab);
    }

    trackByKey(_: number, r: { key?: string }) { return r?.key ?? _; }

    // ── Trial reminder ───────────────────────────────────────────────

    remindMe() {
        const email = (this.remindEmail || '').trim();
        if (!email || this.reminding) return;
        this.reminding = true;
        this.subs.add(this.http.post<any>(`${API}/eval/remind-me`, { email }).subscribe({
            next: () => { this.reminding = false; this.remindSent = true; this.notification.success('We will email you before the evaluation ends'); this.cdr.markForCheck(); },
            error: e => { this.reminding = false; this.notification.error(this.errMsg(e, 'Could not save the reminder — check the address')); this.cdr.markForCheck(); },
        }));
    }

    /** "£1,234.56 held on customers' cards · 12 Stripe holds placed · …" from the server-formatted stats. */
    statsLine(): string {
        const rows: Array<{ label: string; value: string }> = this.meta?.recentStats || [];
        return rows.map(r => `${r.value} ${r.label}`).join(' · ');
    }

    // ── Value metrics ────────────────────────────────────────────────

    usage(key: string): number {
        const v = this.dig(this.summary, `usage.${key}`);
        return typeof v === 'number' && isFinite(v) ? v : 0;
    }

    heldValueLabel(): string {
        const minor = this.dig(this.summary, 'usage.heldValueMinor30d');
        if (typeof minor !== 'number') return '—';
        return this.money(minor, this.dig(this.summary, 'usage.heldCurrency') || null);
    }

    // ── Weekly report ────────────────────────────────────────────────

    private loadDigest() {
        this.digestError = '';
        this.subs.add(this.http.get<DigestSettings>(`${API}/digest/settings`).subscribe({
            next: d => { this.digest = d; this.digestRecipient = d?.recipient || ''; this.cdr.markForCheck(); },
            error: e => { this.digest = null; this.digestError = this.errMsg(e, 'Could not load the weekly report settings'); this.cdr.markForCheck(); },
        }));
    }

    saveDigest(patch: { enabled?: boolean; recipient?: string | null }) {
        if (this.digestSaving) return;
        this.digestSaving = true;
        const body = { ...patch };
        if (body.recipient !== undefined) body.recipient = (body.recipient || '').trim() || null;
        this.subs.add(this.http.post<DigestSettings>(`${API}/digest/settings`, body).subscribe({
            next: d => {
                this.digestSaving = false;
                this.digest = d;
                this.digestRecipient = d?.recipient || '';
                this.notification.success(body.recipient !== undefined ? (d?.recipient ? `Weekly report goes to ${d.recipient}` : 'Recipient cleared — the default address is used') : (d?.enabled ? 'Weekly report on' : 'Weekly report off'));
                this.cdr.markForCheck();
            },
            error: e => { this.digestSaving = false; this.notification.error(this.errMsg(e, 'Could not save the weekly report settings')); this.loadDigest(); this.cdr.markForCheck(); },
        }));
    }

    sendDigestTest() {
        if (this.digestSending) return;
        this.digestSending = true;
        const to = (this.digestRecipient || '').trim();
        this.subs.add(this.http.post<any>(`${API}/digest/send-test`, to ? { to } : {}).subscribe({
            next: r => {
                this.digestSending = false;
                if (r?.sent) this.notification.success(`Test report sent to ${r.to}`);
                else if (r?.reason === 'no-recipient') this.notification.error('No recipient: enter an address above or set ops.adminEmail');
                else this.notification.error(`Not sent: ${r?.reason || 'unknown error'}`);
                this.loadDigest();
                this.cdr.markForCheck();
            },
            error: e => { this.digestSending = false; this.notification.error(this.errMsg(e, 'Could not send the test report')); this.cdr.markForCheck(); },
        }));
    }

    /** Fetched through the same authenticated HttpClient (bearer or cookie) and opened as a Blob URL. */
    previewDigest() {
        if (this.digestPreviewing) return;
        this.digestPreviewing = true;
        this.subs.add(this.http.get(`${API}/digest/preview`, { responseType: 'text' }).subscribe({
            next: html => {
                this.digestPreviewing = false;
                const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
                window.open(url, '_blank', 'noopener');
                setTimeout(() => URL.revokeObjectURL(url), 60_000);
                this.cdr.markForCheck();
            },
            error: e => { this.digestPreviewing = false; this.notification.error(this.errMsg(e, 'Could not build the preview')); this.cdr.markForCheck(); },
        }));
    }

    // ── Actions ──────────────────────────────────────────────────────

    captureHold(h: HoldRow) {
        this.confirm('Capture this payment?', `${this.money(h.amount, h.currency)} for order ${h.orderCode || h.paymentId} will be charged to the customer's card now.`, 'Capture', 'primary')
            .then(ok => ok && this.postAction(`${API}/holds/${h.paymentId}/capture`, 'hold:' + h.paymentId, 'Payment captured', () => { this.loadHolds(); this.loadSummary(); }));
    }

    cancelHold(h: HoldRow) {
        this.confirm('Cancel this hold?', `The authorisation for order ${h.orderCode || h.paymentId} is released and the customer is not charged. The order is left for you to cancel.`, 'Cancel hold', 'danger')
            .then(ok => ok && this.postAction(`${API}/holds/${h.paymentId}/cancel`, 'hold:' + h.paymentId, 'Hold cancelled — funds released', () => { this.loadHolds(); this.loadSummary(); }));
    }

    bankReceived(b: BankRow) {
        this.confirm('Mark as received?', `Confirms ${this.money(b.amount, b.currency)} arrived for reference ${b.reference || b.orderCode || b.paymentId}. The order moves to PaymentSettled.`, 'Mark received', 'primary')
            .then(ok => ok && this.postAction(`${API}/bank-transfers/${b.paymentId}/received`, 'bank:' + b.paymentId, 'Bank transfer marked as received', () => { this.loadBank(); this.loadSummary(); }));
    }

    bankCancel(b: BankRow) {
        this.confirm('Cancel this bank transfer?', `Order ${b.orderCode || b.paymentId} is cancelled and the customer will need to order again.`, 'Cancel order', 'danger')
            .then(ok => ok && this.postAction(`${API}/bank-transfers/${b.paymentId}/cancel`, 'bank:' + b.paymentId, 'Bank transfer cancelled', () => { this.loadBank(); this.loadSummary(); }));
    }

    private postAction(url: string, busyKey: string, okMessage: string, after: () => void) {
        if (this.busyKey) return;
        this.busyKey = busyKey;
        this.cdr.markForCheck();
        this.subs.add(this.http.post<any>(url, {}).subscribe({
            next: r => {
                this.busyKey = '';
                if (r && r.ok === false) this.notification.error(r.message || 'The action was refused');
                else this.notification.success(r?.message || okMessage);
                after();
                this.cdr.markForCheck();
            },
            error: e => { this.busyKey = ''; this.notification.error(this.errMsg(e, 'The action failed')); this.cdr.markForCheck(); },
        }));
    }

    private confirm(title: string, body: string, okLabel: string, style: 'primary' | 'danger'): Promise<boolean> {
        return new Promise(resolve => {
            this.subs.add(this.modal.dialog<boolean>({
                title,
                body,
                buttons: [
                    { type: 'secondary', label: 'Back' },
                    { type: style, label: okLabel, returnValue: true },
                ],
            }).subscribe({ next: v => resolve(!!v), error: () => resolve(false) }));
        });
    }

    // ── Licence & billing (same flow as every HULO plugin) ───────────

    licenceKeyInput = '';
    activating = false;
    buyPlan: 'monthly' | 'annual' | 'lifetime' = 'monthly';
    buying = false;
    claim: any = null;
    portalOpening = false;
    private claimTimer: any = null;

    buyLicence() {
        this.buying = true;
        this.subs.add(this.http.post<any>(`${API}/licence/purchase-link`, { plan: this.buyPlan }).subscribe({
            next: r => {
                this.buying = false;
                if (r?.url) {
                    window.open(r.url, '_blank', 'noopener');
                    this.claim = { state: 'pending' };
                    this.startClaimPoll();
                }
                this.cdr.markForCheck();
            },
            error: e => { this.buying = false; this.notification.error(this.errMsg(e, 'Could not start checkout — try again shortly')); this.cdr.markForCheck(); },
        }));
    }

    buyLifetime() { this.buyPlan = 'lifetime'; this.buyLicence(); }

    checkClaim(force = false) {
        this.subs.add(this.http.get<any>(`${API}/licence/claim-status` + (force ? '?check=1' : '')).subscribe({
            next: r => {
                const wasPending = this.claim?.state === 'pending';
                this.claim = r;
                if (r?.state === 'pending') { if (!this.claimTimer) this.startClaimPoll(); }
                else this.stopClaimPoll();
                if (r?.licensed && (wasPending || r?.state === 'installed') && !this.meta?.licensed) {
                    this.notification.success('Licence installed — all features enabled');
                    this.loadMeta();
                }
                this.cdr.markForCheck();
            },
            error: () => undefined,
        }));
    }

    private startClaimPoll() { this.stopClaimPoll(); this.claimTimer = setInterval(() => this.checkClaim(false), 15000); }
    private stopClaimPoll() { if (this.claimTimer) { clearInterval(this.claimTimer); this.claimTimer = null; } }

    licenceLabel(): string {
        const l: any = this.meta?.licence;
        if (!l) return 'active licence';
        const d = (s: string) => new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
        if (l.master) return 'master licence — covers every HULO plugin on this server';
        if (l.plan === 'lifetime') return 'lifetime licence — never expires, every update included';
        if (l.trialEndsAt && new Date(l.trialEndsAt).getTime() > Date.now()) {
            return `free trial on the ${l.plan} plan — first charge on ${d(l.trialEndsAt)}; cancel any time before then via Manage billing`;
        }
        return `${l.plan} subscription — renews automatically${l.expiresAt ? ' (current key valid until ' + d(l.expiresAt) + ')' : ''}`;
    }

    openPortal() {
        this.portalOpening = true;
        this.subs.add(this.http.post<any>(`${API}/licence/portal-link`, {}).subscribe({
            next: r => { this.portalOpening = false; if (r?.url) window.open(r.url, '_blank', 'noopener'); this.cdr.markForCheck(); },
            error: e => { this.portalOpening = false; this.notification.error(this.errMsg(e, 'Could not open the billing portal')); this.cdr.markForCheck(); },
        }));
    }

    activateLicence() {
        const key = (this.licenceKeyInput || '').trim();
        if (!key) return;
        this.activating = true;
        this.subs.add(this.http.post<any>(`${API}/licence/activate`, { key }).subscribe({
            next: r => {
                this.activating = false;
                this.licenceKeyInput = '';
                this.notification.success(r?.message || 'Licence activated — all features enabled');
                this.loadMeta();
                this.cdr.markForCheck();
            },
            error: e => {
                this.activating = false;
                this.notification.error(this.errMsg(e, 'That key did not validate — check it was copied completely'));
                this.cdr.markForCheck();
            },
        }));
    }

    updateAvailable(): boolean {
        const u = this.meta?.update;
        return !!(u && u.latest && u.updateAvailable !== false && u.latest !== this.meta?.version);
    }

    // ── Derived values for the template ──────────────────────────────

    /** Reads a KPI from the summary, tolerating either a flat key or a nested `{ group: { field } }` shape. */
    kpi(key: string): number {
        const s = this.summary;
        if (!s) return 0;
        const aliases: Record<string, string[]> = {
            holdsPending: ['holdsPending', 'holds.pending', 'holds'],
            bankAwaiting: ['bankAwaiting', 'bankTransfersAwaiting', 'bank.awaiting', 'bankTransfers.awaiting'],
            failed7d: ['failed7d', 'failedPayments7d', 'failed.7d', 'events.failed7d'],
            orphansOpen: ['orphansOpen', 'orphans.open', 'orphans'],
            drift30d: ['drift30d', 'amountDrift30d', 'drift.30d'],
        };
        for (const path of aliases[key] || [key]) {
            const v = this.dig(s, path);
            if (typeof v === 'number') return v;
            if (typeof v === 'string' && v !== '' && !isNaN(Number(v))) return Number(v);
        }
        return 0;
    }

    dropOffLabel(): string {
        const s = this.summary;
        if (!s) return '—';
        for (const path of ['funnelDropOffPct', 'funnelDropOff', 'funnel.dropOffPct', 'funnel.dropOff']) {
            const v = this.dig(s, path);
            if (typeof v === 'number' && isFinite(v)) return `${Math.round(v * 10) / 10}%`;
        }
        return '—';
    }

    attentionCount(): number {
        return this.kpi('holdsPending') + this.kpi('bankAwaiting') + this.kpi('orphansOpen');
    }

    statusSentence(): string {
        if (!this.summary) return this.loading ? 'Loading…' : 'Summary unavailable.';
        const parts: string[] = [];
        const h = this.kpi('holdsPending'); if (h) parts.push(`${h} Stripe hold${h === 1 ? '' : 's'} waiting for capture`);
        const b = this.kpi('bankAwaiting'); if (b) parts.push(`${b} bank transfer${b === 1 ? '' : 's'} awaiting funds`);
        const o = this.kpi('orphansOpen'); if (o) parts.push(`${o} orphaned Stripe charge${o === 1 ? '' : 's'} to investigate`);
        const tier = this.premiumLocked ? 'Free tier: guards, funnel and bank transfer are active; holds, auto-expiry, reconciliation and alerts are waiting for a licence.' : 'All protections active.';
        return parts.length ? `${parts.join(' · ')}. ${tier}` : `Nothing needs attention. ${tier}`;
    }

    safetyCaptureDays(): number { return this.numOr(this.dig(this.settings, 'stripe.safetyCaptureDays'), 6); }
    bankExpiryDays(): number { return this.numOr(this.dig(this.settings, 'bankTransfer.expiryDays'), 7); }
    publicBaseUrl(): string { return String(this.dig(this.settings, 'publicBaseUrl') || this.dig(this.settings, 'general.publicBaseUrl') || 'https://<publicBaseUrl>'); }
    flag(section: string, key: string): boolean { return !!this.dig(this.settings, `${section}.${key}`); }
    opsConfigured(): boolean {
        const ops = this.settings?.ops;
        if (!ops || typeof ops !== 'object') return false;
        return Object.values(ops).some(v => v === true || (typeof v === 'string' && v.length > 0));
    }

    kindLabel(kind: string): string { return EVENT_KINDS.find(k => k.key === kind)?.label || kind; }
    kindClass(kind: string): string {
        switch (kind) {
            case 'orphan': case 'amount_drift': return 'lvl-bad';
            case 'failed': case 'client_declined': case 'hold_expired': return 'lvl-warn';
            case 'bank_expired': return 'lvl-info';
            default: return '';
        }
    }
    isSideStep(step: string): boolean { return FUNNEL_SIDE_STEPS.some(s => s.key === step); }

    /** Minor units → localised currency string; without a currency the value is shown as a plain decimal. */
    private readonly formatters = new Map<string, Intl.NumberFormat>();
    trackById(_: number, r: { id?: number | string }) { return r?.id ?? _; }
    trackByPayment(_: number, r: { paymentId?: number | string }) { return r?.paymentId ?? _; }

    money(minor: number | null | undefined, currency?: string | null): string {
        if (minor == null || isNaN(Number(minor))) return '—';
        const major = Number(minor) / 100;
        if (currency) {
            try {
                let f = this.formatters.get(currency);
                if (!f) { f = new Intl.NumberFormat(undefined, { style: 'currency', currency }); this.formatters.set(currency, f); }
                return f.format(major);
            } catch { /* unknown code */ }
        }
        return major.toFixed(2) + (currency ? ' ' + currency : '');
    }

    hoursUntil(iso: string): number { return (new Date(iso).getTime() - Date.now()) / 3_600_000; }

    relative(iso: string): string {
        const h = this.hoursUntil(iso);
        const abs = Math.abs(h);
        const unit = abs >= 48 ? `${Math.round(abs / 24)} days` : abs >= 1 ? `${Math.round(abs)} h` : `${Math.max(1, Math.round(abs * 60))} min`;
        return h < 0 ? `${unit} ago` : `in ${unit}`;
    }

    // ── Normalisers ──────────────────────────────────────────────────

    private asList<T>(r: any, ...keys: string[]): T[] {
        if (Array.isArray(r)) return r as T[];
        if (r && typeof r === 'object') {
            for (const k of keys) if (Array.isArray(r[k])) return r[k] as T[];
        }
        return [];
    }

    /** Accepts `{ steps: [{ step, count, dropOffPct? }] }`, `{ counts: { step: n } }` or a flat `{ step: n }` map. */
    private normaliseFunnel(r: any): FunnelStep[] {
        const counts: Record<string, number> = {};
        const serverDrop: Record<string, number | null> = {};
        if (r && Array.isArray(r.steps)) {
            for (const s of r.steps) {
                const key = String(s.step ?? s.key ?? s.name ?? '');
                if (!key) continue;
                counts[key] = Number(s.unique ?? s.count ?? s.sessions ?? s.events ?? s.total ?? 0) || 0;
                if (typeof s.dropOffPct === 'number') serverDrop[key] = s.dropOffPct;
                else if (typeof s.dropOff === 'number') serverDrop[key] = s.dropOff;
            }
        } else {
            const src = r && typeof r.counts === 'object' ? r.counts : r;
            if (src && typeof src === 'object') {
                for (const k of Object.keys(src)) if (typeof src[k] === 'number') counts[k] = src[k];
            }
            if (r && typeof r.dropOff === 'object') for (const k of Object.keys(r.dropOff)) if (typeof r.dropOff[k] === 'number') serverDrop[k] = r.dropOff[k];
        }
        const known = [...FUNNEL_STEPS, ...FUNNEL_SIDE_STEPS];
        const hasAny = Object.keys(counts).length > 0;
        if (!hasAny) return [];
        const base = counts['cart'] ?? FUNNEL_STEPS.map(s => counts[s.key]).find(v => typeof v === 'number') ?? 0;
        const out: FunnelStep[] = [];
        let prev: number | null = null;
        for (const s of FUNNEL_STEPS) {
            const c = counts[s.key] ?? 0;
            let drop: number | null = serverDrop[s.key] ?? null;
            if (drop == null) drop = prev == null || prev === 0 ? null : Math.max(0, ((prev - c) / prev) * 100);
            out.push({ step: s.key, label: s.label, count: c, dropOffPct: drop, sharePct: base > 0 ? Math.min(100, (c / base) * 100) : 0 });
            prev = c;
        }
        for (const s of FUNNEL_SIDE_STEPS) {
            out.push({ step: s.key, label: s.label, count: counts[s.key] ?? 0, dropOffPct: null, sharePct: 0 });
        }
        for (const k of Object.keys(counts)) {
            if (!known.some(s => s.key === k)) out.push({ step: k, label: k, count: counts[k], dropOffPct: null, sharePct: 0 });
        }
        return out;
    }

    /** Flattens the settings object into titled key/value sections; unknown top-level keys get their own section. */
    private buildSettingsSections(s: any): SettingsSection[] {
        if (!s || typeof s !== 'object') return [];
        const sections: SettingsSection[] = [];
        const general: Array<{ key: string; value: string }> = [];
        const used = new Set<string>();
        for (const k of Object.keys(s)) {
            const v = s[k];
            if (v === null || typeof v !== 'object' || Array.isArray(v)) { general.push({ key: k, value: this.fmtValue(v) }); used.add(k); }
        }
        for (const def of SETTINGS_SECTIONS) {
            if (def.key === 'general') { if (general.length) sections.push({ key: 'general', title: def.title, rows: general }); continue; }
            const v = s[def.key];
            if (v && typeof v === 'object') { sections.push({ key: def.key, title: def.title, rows: this.flatten(v) }); used.add(def.key); }
        }
        for (const k of Object.keys(s)) {
            if (used.has(k)) continue;
            const v = s[k];
            if (v && typeof v === 'object') sections.push({ key: k, title: k, rows: this.flatten(v) });
        }
        return sections;
    }

    private flatten(obj: any, prefix = ''): Array<{ key: string; value: string }> {
        const rows: Array<{ key: string; value: string }> = [];
        for (const k of Object.keys(obj)) {
            const v = obj[k];
            const key = prefix ? `${prefix}.${k}` : k;
            if (v && typeof v === 'object' && !Array.isArray(v)) rows.push(...this.flatten(v, key));
            else rows.push({ key, value: this.fmtValue(v) });
        }
        return rows;
    }

    private fmtValue(v: any): string {
        if (v === undefined || v === null || v === '') return 'not set';
        if (v === true) return 'yes';
        if (v === false) return 'no';
        if (Array.isArray(v)) return v.length ? v.map(x => this.fmtValue(x)).join(', ') : 'none';
        return String(v);
    }

    private dig(obj: any, path: string): any {
        return path.split('.').reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), obj);
    }

    private numOr(v: any, fallback: number): number {
        const n = Number(v);
        return v != null && v !== '' && !isNaN(n) ? n : fallback;
    }

    private errMsg(e: any, fallback: string): string {
        const code = e?.error?.error;
        if (e?.status === 402 || code === 'licence-required' || code === 'licence_required' || code === 'premium-feature' || code === 'premium_required') {
            return `${fallback.replace(/^Could not /, '').replace(/^The action failed$/, 'This action')} needs a licence — start the free trial or activate a key at the top of this page.`;
        }
        return e?.error?.message || e?.message || fallback;
    }
}
