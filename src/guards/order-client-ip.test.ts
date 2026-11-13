import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CG_CLIENT_IP_FIELD, OrderClientIpSubscriber, orderClientIpField, readOrderClientIp, registerOrderClientIpField, setOrderClientIpRuntime,
} from './order-client-ip';

vi.mock('@vendure/core', () => ({
    LanguageCode: { en: 'en' }, Order: class Order {}, OrderPlacedEvent: class {}, OrderStateTransitionEvent: class {},
    Logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

afterEach(() => setOrderClientIpRuntime({ field: () => null, clientIp: () => ({}) }));

describe('order client IP (opt-in)', () => {
    it('is off by default and registers nothing', () => {
        const config: any = { customFields: { Order: [] } };
        expect(registerOrderClientIpField(config, undefined)).toBeNull();
        expect(registerOrderClientIpField(config, false)).toBeNull();
        expect(config.customFields.Order).toEqual([]);
    });

    it('registers cgClientIp once, admin-readable and not public', () => {
        const config: any = { customFields: { Order: [] } };
        expect(registerOrderClientIpField(config, true)).toBe(CG_CLIENT_IP_FIELD);
        registerOrderClientIpField(config, true);
        expect(config.customFields.Order).toHaveLength(1);
        expect(config.customFields.Order[0]).toMatchObject({ name: 'cgClientIp', type: 'string', public: false, readonly: true, nullable: true });
    });

    it('reuses a host field of the given name', () => {
        const host = { name: 'ip', type: 'string' };
        const config: any = { customFields: { Order: [host] } };
        expect(registerOrderClientIpField(config, { fieldName: 'ip' })).toBe('ip');
        expect(config.customFields.Order).toEqual([host]);
        expect(orderClientIpField({ fieldName: 'bad name' })).toBeNull();
    });

    it('writes the Shop API client IP at ArrangingPayment, never from admin or webhook contexts', async () => {
        setOrderClientIpRuntime({ field: () => 'cgClientIp', clientIp: () => ({}) });
        const update = vi.fn(async () => undefined);
        const sub = new OrderClientIpSubscriber({} as any, { getRepository: () => ({ update }) } as any);
        const order: any = { id: 7, code: 'O7', customFields: {} };
        const shop: any = { apiType: 'shop', req: { ip: '198.51.100.20', headers: {}, socket: { remoteAddress: '198.51.100.20' } } };
        expect(await sub.write(shop, order, true)).toBe('198.51.100.20');
        expect(update).toHaveBeenCalledWith({ id: 7 }, { customFields: { cgClientIp: '198.51.100.20' } });
        expect(readOrderClientIp(order)).toBe('198.51.100.20');
        // Placement does not overwrite an IP already there.
        expect(await sub.write({ ...shop, req: { ip: '198.51.100.99', headers: {}, socket: {} } }, order, false)).toBeNull();
        expect(await sub.write({ apiType: 'admin', req: shop.req } as any, { id: 8, customFields: {} } as any, true)).toBeNull();
        expect(update).toHaveBeenCalledTimes(1);
    });
});
