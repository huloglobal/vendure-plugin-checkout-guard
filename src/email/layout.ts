/**
 * Shared e-mail layout for the customer and merchant messages Checkout Guard
 * sends itself (bank-transfer reminder and expiry e-mails, ops alerts).
 *
 * A 600px white card on a light grey background, the merchant's logo or
 * store name over a 3px accent bar, then the content, the sign-off and an
 * optional footer strip. Inline styles and tables only (some senders strip
 * `<style>` blocks); every interpolated value is escaped here or by the
 * caller through `esc()`. Nothing in it names the plugin's vendor: these
 * messages go out under the merchant's own name.
 *
 * Pure: no I/O, so every message is unit-tested.
 */

export const DEFAULT_ACCENT = '#155dfc';
const FONT = 'Arial, Helvetica, sans-serif';
const MONO = 'Consolas, Menlo, Monaco, monospace';

/** The merchant's look for the messages. Every field optional. */
export interface EmailBranding {
    /** Store name for the header (when there is no logo) and the sign-off. */
    storeName?: string;
    /** Accent colour (`#rgb` or `#rrggbb`), default `#155dfc`. */
    accentColor?: string;
    /** Absolute https URL of the logo shown in the header instead of the store name. */
    logoUrl?: string;
    /** Logo width in pixels (default 140). */
    logoWidth?: number;
    /** Support address shown in the sign-off and the "Need help?" line. */
    supportEmail?: string;
    /** Footer or legal line (company name, registration, address). */
    footerText?: string;
    /** Storefront URL; the header logo links to it. */
    storeUrl?: string;
}

export function esc(s: unknown): string {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** A safe accent colour: the configured one when it is a hex colour, else the default. */
export function accentOf(b?: EmailBranding | null): string {
    const c = String(b?.accentColor || '').trim();
    return HEX.test(c) ? c : DEFAULT_ACCENT;
}

/** Only absolute http(s) URLs are put into an href or src. */
export function safeUrl(u: unknown): string | null {
    const s = String(u ?? '').trim();
    if (!/^https?:\/\/[^\s"'<>]+$/i.test(s)) return null;
    try { new URL(s); return s; } catch { return null; }
}

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
export function safeEmail(e: unknown): string | null {
    const s = String(e ?? '').trim();
    return s.length <= 254 && EMAIL_RE.test(s) ? s : null;
}

// ── Building blocks (each returns HTML; text arguments are escaped) ─────────

export function label(text: string): string {
    return `<div style="font-family:${FONT};font-size:12px;line-height:16px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;font-weight:bold;padding-bottom:6px;">${esc(text)}</div>`;
}

export function paragraph(text: string, opts: { compact?: boolean } = {}): string {
    return `<p style="margin:0 0 ${opts.compact ? 10 : 14}px 0;font-family:${FONT};font-size:14px;line-height:22px;color:#374151;">${esc(text)}</p>`;
}

/** A key/value row; `mono` for codes, references and account numbers. */
export interface Row { label: string; value: string; mono?: boolean; accent?: boolean; strong?: boolean }

function rowsTable(rows: Row[], accent: string, labelColour: string): string {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:${FONT};font-size:14px;color:#111827;">${rows.map(r =>
        `<tr><td style="padding:3px 12px 3px 0;color:${labelColour};vertical-align:top;">${esc(r.label)}</td><td align="right" style="padding:3px 0;font-weight:${r.strong === false ? 'normal' : 'bold'};${r.mono ? `font-family:${MONO};` : ''}${r.accent ? `color:${accent};` : ''}word-break:break-all;">${esc(r.value)}</td></tr>`,
    ).join('')}</table>`;
}

/** Grey info box with an optional label and key/value rows. */
export function infoBox(rows: Row[], opts: { title?: string; accent?: string } = {}): string {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:0 0 16px 0;"><tr><td style="padding:14px 16px;background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">${opts.title ? label(opts.title) : ''}${rowsTable(rows, opts.accent || DEFAULT_ACCENT, '#6b7280')}</td></tr></table>`;
}

/** Amber warning box: a title, an intro line, rows and an optional note. */
export function warningBox(opts: { title: string; intro?: string; rows?: Row[]; note?: string; accent?: string }): string {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:0 0 16px 0;"><tr><td style="padding:16px;background-color:#fffbeb;border:1px solid #fde68a;border-radius:8px;">`
        + `<div style="font-family:${FONT};font-size:15px;font-weight:bold;color:#92400e;padding-bottom:6px;">${esc(opts.title)}</div>`
        + (opts.intro ? `<div style="font-family:${FONT};font-size:13px;line-height:20px;color:#78350f;padding-bottom:10px;">${esc(opts.intro)}</div>` : '')
        + (opts.rows?.length ? rowsTable(opts.rows, opts.accent || DEFAULT_ACCENT, '#6b7280') : '')
        + (opts.note ? `<div style="font-family:${FONT};font-size:12px;line-height:18px;color:#78350f;padding-top:8px;">${esc(opts.note)}</div>` : '')
        + `</td></tr></table>`;
}

/** Primary (accent background) or secondary (accent outline) button. Returns '' for an unsafe URL. */
export function button(href: string, text: string, accent: string, kind: 'primary' | 'secondary' = 'primary'): string {
    const url = safeUrl(href);
    if (!url) return '';
    const style = kind === 'primary'
        ? `background-color:${accent};border:1px solid ${accent};color:#ffffff;`
        : `background-color:#ffffff;border:1px solid ${accent};color:${accent};`;
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px 0;"><tr><td style="border-radius:8px;${kind === 'primary' ? `background-color:${accent};` : ''}"><a href="${esc(url)}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;font-weight:bold;text-decoration:none;border-radius:8px;${style}">${esc(text)}</a></td></tr></table>`;
}

// ── The page ────────────────────────────────────────────────────────────────

export interface LayoutInput {
    branding?: EmailBranding | null;
    /** Hidden preview line shown by mail clients next to the subject. */
    preheader?: string;
    heading: string;
    /** Body HTML built from the blocks above (already escaped). */
    body: string;
    /** Customer messages sign off with "Kind regards," and the store; admin alerts omit it. */
    signOff?: boolean;
    /** Merchant/admin variant: tighter padding and a smaller heading. */
    compact?: boolean;
}

export function renderLayout(input: LayoutInput): string {
    const b = input.branding || {};
    const accent = accentOf(b);
    const store = String(b.storeName || '').trim();
    const logo = safeUrl(b.logoUrl);
    const storeUrl = safeUrl(b.storeUrl);
    const support = safeEmail(b.supportEmail);
    const width = Math.max(40, Math.min(300, Math.round(Number(b.logoWidth) || 140)));
    const pad = input.compact ? '18px 22px' : '28px 28px';
    const headPad = input.compact ? '14px 22px' : '22px 28px';
    const brandInner = logo
        ? `<img src="${esc(logo)}" alt="${esc(store || 'Logo')}" width="${width}" style="display:block;border:0;outline:none;width:${width}px;max-width:100%;height:auto;">`
        : `<span style="font-family:${FONT};font-size:${input.compact ? 16 : 20}px;font-weight:bold;color:#111827;">${esc(store || ' ')}</span>`;
    const brand = storeUrl ? `<a href="${esc(storeUrl)}" style="text-decoration:none;color:#111827;">${brandInner}</a>` : brandInner;
    const signOff = input.signOff === false ? '' : `<p style="margin:8px 0 0 0;font-family:${FONT};font-size:14px;line-height:22px;color:#374151;">Kind regards,<br><strong style="color:#111827;">${esc(store || 'The team')}</strong>${support ? `<br><a href="mailto:${esc(support)}" style="color:${accent};text-decoration:none;">${esc(support)}</a>` : ''}</p>`;
    const footerText = String(b.footerText || '').trim();
    const footer = footerText
        ? `<tr><td style="padding:12px ${input.compact ? 22 : 28}px;background-color:#f9fafb;border-top:1px solid #e5e7eb;border-radius:0 0 10px 10px;font-family:${FONT};font-size:11px;line-height:16px;color:#6b7280;">${esc(footerText).replace(/\r?\n/g, '<br>')}</td></tr>`
        : '';
    const preheader = input.preheader
        ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(input.preheader)}</div>`
        : '';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(input.heading)}</title></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;">${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate;">
<tr><td style="padding:${headPad};border-bottom:3px solid ${accent};">${brand}</td></tr>
<tr><td style="padding:${pad};">
<h1 style="margin:0 0 ${input.compact ? 10 : 14}px 0;font-family:${FONT};font-size:${input.compact ? 18 : 22}px;line-height:${input.compact ? 24 : 28}px;font-weight:bold;color:#111827;">${esc(input.heading)}</h1>
${input.body}${signOff}
</td></tr>
${footer}
</table>
</td></tr></table>
</body></html>`;
}

/** Plain-text twin: heading, body lines, rows as "Label: value", sign-off, footer. */
export function renderText(input: { branding?: EmailBranding | null; heading: string; lines: string[]; signOff?: boolean }): string {
    const b = input.branding || {};
    const store = String(b.storeName || '').trim();
    const support = safeEmail(b.supportEmail);
    const parts = [input.heading, '', ...input.lines];
    if (input.signOff !== false) parts.push('', 'Kind regards,', store || 'The team', ...(support ? [support] : []));
    const footer = String(b.footerText || '').trim();
    if (footer) parts.push('', '--', footer);
    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function rowsText(rows: Row[]): string[] {
    return rows.map(r => `${r.label}: ${r.value}`);
}
