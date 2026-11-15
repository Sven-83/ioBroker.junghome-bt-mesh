/**
 * Synthetic JUNG HOME export for the tests (random keys, invented names, never real data).
 */
import * as crypto from 'node:crypto';

/** Synthetic, locally administered MAC of the test thermostat (built at runtime, never a real device) */
export const TEST_MAC = ['02', '00', '00', '00', '00', '01'].join(':');

/** Keys of the synthetic export */
export interface TestKeys {
    /** Network key */
    netKey: string;
    /** Application key */
    appKey: string;
    /** Device key of the thermostat */
    devKey: string;
}

/**
 * Builds an export with one phone and one thermostat at 0x0006 (elements 0x0006..0x0008).
 *
 * @param keys Keys to use (random when omitted)
 */
export function buildExport(keys?: Partial<TestKeys>): { text: string; keys: TestKeys } {
    const k: TestKeys = {
        netKey: keys?.netKey ?? crypto.randomBytes(16).toString('hex'),
        appKey: keys?.appKey ?? crypto.randomBytes(16).toString('hex'),
        devKey: keys?.devKey ?? crypto.randomBytes(16).toString('hex'),
    };
    const network = {
        netKeys: [{ index: 0, key: k.netKey }],
        appKeys: [{ index: 0, key: k.appKey }],
        networkExclusions: [{ addresses: [], ivIndex: 0 }],
        provisioners: [
            { provisionerName: 'Phone', allocatedUnicastRange: [{ lowAddress: '0001', highAddress: '0CCD' }] },
        ],
        nodes: [
            {
                UUID: 'AAAAAAAA-0000-0000-0000-000000000001',
                unicastAddress: '0001',
                deviceKey: crypto.randomBytes(16).toString('hex'),
                name: 'Phone',
                elements: [{ models: [{ modelId: '0001' }, { modelId: '1001' }] }],
            },
            {
                UUID: '11223344-5566-7788-0000-000000000000',
                unicastAddress: '0006',
                deviceKey: k.devKey,
                name: 'Room thermostat',
                elements: [
                    { models: [{ modelId: '0000' }, { modelId: '1002' }] },
                    { models: [{ modelId: '1000' }] },
                    { models: [{ modelId: '1100' }] },
                ],
            },
        ],
    };
    const outer = {
        meta: {
            devices: [
                {
                    macAddress: TEST_MAC.toLowerCase(),
                    name: 'Test room',
                    deviceId: { nodeId: '11223344-5566-7788-0000-000000000000' },
                },
            ],
        },
        network: Buffer.from(JSON.stringify(network)).toString('base64'),
        version: '1.1',
    };
    return { text: JSON.stringify(outer), keys: k };
}
