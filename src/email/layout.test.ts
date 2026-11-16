import { describe, expect, it } from 'vitest';
import { accentOf, button, DEFAULT_ACCENT, esc, renderLayout, renderText, safeEmail, safeUrl } from './layout';

describe('shared e-mail layout', () => {
    it('escapes HTML special characters', () => {
        expect(esc(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
        expect(esc(null)).toBe('');
    });

    it('accepts only hex accent colours', () => {
        expect(accentOf({ accentColor: '#abc' })).toBe('#abc');
        expect(accentOf({ accentColor: '#A1B2C3' })).toBe('#A1B2C3');
        expect(accentOf({ accentColor: 'red' })).toBe(DEFAULT_ACCENT);
        expect(accentOf(null)).toBe('#155dfc');
    });

    it('accepts only absolute http(s) URLs and plain addresses', () => {
        expect(safeUrl('https://a.test/x?y=1')).toBe('https://a.test/x?y=1');
        expect(safeUrl('javascript:alert(1)')).toBeNull();
        expect(safeUrl('https://a.test/"onx')).toBeNull();
        expect(safeEmail('a@b.co')).toBe('a@b.co');
        expect(safeEmail('a@b')).toBeNull();
        expect(safeEmail('"x"@b.co')).toBeNull();
    });

    it('renders primary and secondary buttons and refuses unsafe links', () => {
        expect(button('https://a.test', 'Go', '#123456')).toContain('background-color:#123456');
        expect(button('https://a.test', 'Go', '#123456', 'secondary')).toContain('color:#123456');
        expect(button('data:text/html,x', 'Go', '#123456')).toBe('');
    });

    it('renders the card, header, sign-off and footer with inline styles only', () => {
        const html = renderLayout({ branding: { storeName: 'Shop', supportEmail: 'help@shop.test', footerText: 'Line 1\nLine 2' }, heading: 'Hello', body: '<p>Body</p>' });
        expect(html).toContain('width="600"');
        expect(html).toContain('border:1px solid #e5e7eb;border-radius:10px');
        expect(html).toContain('font-size:22px');
        expect(html).toContain('Kind regards,<br><strong style="color:#111827;">Shop</strong>');
        expect(html).toContain('Line 1<br>Line 2');
        expect(html).toContain('font-size:11px');
        expect(html).not.toMatch(/<style/i);
        expect(html).not.toMatch(/HULO|ELITE/);
    });

    it('omits the footer strip when no footer text is set', () => {
        expect(renderLayout({ heading: 'H', body: '' })).not.toContain('border-radius:0 0 10px 10px');
    });

    it('renders the plain-text twin', () => {
        expect(renderText({ branding: { storeName: 'Shop', footerText: 'Legal' }, heading: 'H', lines: ['a', '', '', 'b'] }))
            .toBe('H\n\na\n\nb\n\nKind regards,\nShop\n\n--\nLegal\n');
    });
});
