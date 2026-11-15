/**
 * Parser for the JUNG HOME app project export (Project → Project handover, JungHome.json).
 * The export holds all mesh keys: treat its content like a password.
 */

/** One JUNG HOME room thermostat found in the export */
export interface ThermostatInfo {
    /** Primary unicast address (setpoint element, Generic Level) */
    address: number;
    /** Name given in the JUNG HOME app (usually the room) */
    name: string;
    /** BLE MAC address, upper case with colons */
    mac: string;
    /** Element with the Generic Level server (setpoint) */
    levelAddress: number;
    /** Element with the Generic OnOff server (heating output) */
    onOffAddress: number;
    /** Element with the Sensor server (room temperature) */
    sensorAddress: number;
}

/** Everything the adapter needs from the export */
export interface MeshExport {
    /** Network key */
    netKey: Buffer;
    /** Application key */
    appKey: Buffer;
    /** IV index */
    ivIndex: number;
    /** Device keys by primary unicast address */
    deviceKeys: Map<number, Buffer>;
    /** Unicast ranges of all nodes [first, last] */
    nodeRanges: Array<[number, number]>;
    /** Unicast ranges reserved for provisioners (app) [low, high] */
    provisionerRanges: Array<[number, number]>;
    /** Room thermostats found in the export */
    thermostats: ThermostatInfo[];
}

interface RawModel {
    modelId: string;
}
interface RawElement {
    models: RawModel[];
}
interface RawNode {
    UUID: string;
    unicastAddress: string;
    deviceKey: string;
    name?: string;
    elements: RawElement[];
}
interface RawNetwork {
    netKeys: Array<{ key: string }>;
    appKeys: Array<{ key: string }>;
    nodes: RawNode[];
    provisioners?: Array<{ allocatedUnicastRange?: Array<{ lowAddress: string; highAddress: string }> }>;
    networkExclusions?: Array<{ ivIndex?: number }>;
}
interface RawDevice {
    macAddress?: string;
    name?: string;
    deviceId?: { nodeId?: string };
}

const MODEL_GENERIC_ONOFF_SERVER = '1000';
const MODEL_GENERIC_LEVEL_SERVER = '1002';
const MODEL_SENSOR_SERVER = '1100';

function key16(value: unknown, what: string): Buffer {
    if (typeof value !== 'string' || !/^[0-9a-fA-F]{32}$/.test(value)) {
        throw new Error(`${what} is missing or not 16 bytes`);
    }
    return Buffer.from(value, 'hex');
}

function address(value: unknown, what: string): number {
    if (typeof value !== 'string' || !/^[0-9a-fA-F]{4}$/.test(value)) {
        throw new Error(`${what} is not a 4-digit hex address`);
    }
    return parseInt(value, 16);
}

/**
 * Parses the export file content. Throws an Error with a message that never contains key material.
 *
 * @param text Content of JungHome.json
 */
export function parseMeshExport(text: string): MeshExport {
    let outer: { network?: unknown; meta?: { devices?: RawDevice[] } };
    try {
        outer = JSON.parse(text) as typeof outer;
    } catch {
        throw new Error('the export is not valid JSON');
    }
    if (typeof outer.network !== 'string') {
        throw new Error('the export has no "network" part');
    }
    let net: RawNetwork;
    try {
        net = JSON.parse(Buffer.from(outer.network, 'base64').toString('utf8')) as RawNetwork;
    } catch {
        throw new Error('the "network" part of the export cannot be decoded');
    }
    if (!Array.isArray(net.netKeys) || !Array.isArray(net.appKeys) || !Array.isArray(net.nodes)) {
        throw new Error('the export has no keys or nodes');
    }
    const netKey = key16(net.netKeys[0]?.key, 'NetKey');
    const appKey = key16(net.appKeys[0]?.key, 'AppKey');
    const ivIndex = Number(net.networkExclusions?.[0]?.ivIndex ?? 0) >>> 0;

    const deviceKeys = new Map<number, Buffer>();
    const nodeRanges: Array<[number, number]> = [];
    const devices = Array.isArray(outer.meta?.devices) ? outer.meta.devices : [];
    const thermostats: ThermostatInfo[] = [];

    for (const node of net.nodes) {
        const base = address(node.unicastAddress, 'node address');
        const elements = Array.isArray(node.elements) ? node.elements : [];
        nodeRanges.push([base, base + Math.max(1, elements.length) - 1]);
        if (typeof node.deviceKey === 'string' && /^[0-9a-fA-F]{32}$/.test(node.deviceKey)) {
            deviceKeys.set(base, Buffer.from(node.deviceKey, 'hex'));
        }
        const elementWith = (model: string): number =>
            elements.findIndex(e => Array.isArray(e.models) && e.models.some(m => m.modelId === model));
        const level = elementWith(MODEL_GENERIC_LEVEL_SERVER);
        const onOff = elementWith(MODEL_GENERIC_ONOFF_SERVER);
        const sensor = elementWith(MODEL_SENSOR_SERVER);
        if (level < 0 || onOff < 0 || sensor < 0) {
            continue; // not a room thermostat (e.g. the phone)
        }
        const device = devices.find(d => d.deviceId?.nodeId?.toUpperCase() === String(node.UUID).toUpperCase());
        const mac = device?.macAddress?.toUpperCase();
        if (!mac || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) {
            continue; // no MAC → cannot be reached through a proxy
        }
        thermostats.push({
            address: base,
            name: (device?.name || node.name || `Thermostat ${base.toString(16)}`).trim(),
            mac,
            levelAddress: base + level,
            onOffAddress: base + onOff,
            sensorAddress: base + sensor,
        });
    }

    const provisionerRanges: Array<[number, number]> = [];
    for (const p of net.provisioners ?? []) {
        for (const r of p.allocatedUnicastRange ?? []) {
            provisionerRanges.push([
                address(r.lowAddress, 'provisioner range'),
                address(r.highAddress, 'provisioner range'),
            ]);
        }
    }

    return { netKey, appKey, ivIndex, deviceKeys, nodeRanges, provisionerRanges, thermostats };
}

/**
 * Checks the own unicast address, returns an error text or null.
 *
 * @param own Own unicast address
 * @param exp Parsed export
 */
export function checkOwnAddress(own: number, exp: MeshExport): string | null {
    if (!Number.isInteger(own) || own < 0x0001 || own > 0x7fff) {
        return 'the own address must be a unicast address between 0001 and 7FFF';
    }
    for (const [a, b] of exp.nodeRanges) {
        if (own >= a && own <= b) {
            return `the own address ${own.toString(16).padStart(4, '0')} belongs to a device in the mesh`;
        }
    }
    for (const [a, b] of exp.provisionerRanges) {
        if (own >= a && own <= b) {
            return `the own address ${own.toString(16).padStart(4, '0')} is inside the range of the JUNG HOME app`;
        }
    }
    return null;
}
