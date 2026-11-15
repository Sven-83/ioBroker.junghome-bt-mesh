/**
 * JUNG HOME room thermostat (insert 5xxx RTR, "LS 1790 D" style display) over Bluetooth Mesh.
 *
 * Verified on hardware (11.11.2026):
 * - Setpoint = Generic Level on the primary element, °C = 5 + 25 · pct / 100, pct = (level + 32768) / 65535
 * - Heating output = Generic OnOff server on the second element
 * - Room temperature = Sensor server, property 0x004F (Temperature 8, 0.5 °C steps)
 * - Vendor message 0xD12705 (JUNG, company 0x0527) carries admin properties, 0x120B = operating mode
 */
import type { AccessMessage } from './mesh-codec';
import type { ThermostatInfo } from './mesh-export';

export const OP_GENERIC_ONOFF_GET = 0x8201;
export const OP_GENERIC_ONOFF_STATUS = 0x8204;
export const OP_GENERIC_LEVEL_GET = 0x8205;
export const OP_GENERIC_LEVEL_SET = 0x8206;
export const OP_GENERIC_LEVEL_STATUS = 0x8208;
export const OP_SENSOR_GET = 0x8231;
export const OP_SENSOR_STATUS = 0x52;
export const OP_JUNG_ADMIN_STATUS = 0xd12705;

export const PROPERTY_TEMPERATURE_8 = 0x004f;
export const PROPERTY_JUNG_OPERATING_MODE = 0x120b;

export const SETPOINT_MIN = 5;
export const SETPOINT_MAX = 30;
export const SETPOINT_STEP = 0.5;

/**
 * Converts a Generic Level value to °C (rounded to the 0.5 °C grid of the device).
 *
 * @param level Signed 16-bit Generic Level
 */
export function levelToCelsius(level: number): number {
    const pct = Math.min(100, Math.max(0, Math.round(((level + 32768) * 100) / 65535)));
    return roundSetpoint(SETPOINT_MIN + ((SETPOINT_MAX - SETPOINT_MIN) * pct) / 100);
}

/**
 * Converts °C to the Generic Level value the thermostat expects (whole percent, verified on hardware).
 *
 * @param celsius Setpoint inside 5..30 °C
 */
export function celsiusToLevel(celsius: number): number {
    const pct = Math.round(((celsius - SETPOINT_MIN) / (SETPOINT_MAX - SETPOINT_MIN)) * 100);
    return Math.round((pct / 100) * 65535) - 32768;
}

/**
 * Rounds to the 0.5 °C grid of the device.
 *
 * @param celsius Temperature
 */
export function roundSetpoint(celsius: number): number {
    return Math.round(celsius / SETPOINT_STEP) * SETPOINT_STEP;
}

/**
 * Checks a requested setpoint. Returns the value on the device grid or an error text.
 *
 * @param value Value written by the user
 */
export function validateSetpoint(value: unknown): { ok: true; celsius: number } | { ok: false; error: string } {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
        return { ok: false, error: 'the setpoint needs a number' };
    }
    if (n < SETPOINT_MIN || n > SETPOINT_MAX) {
        return { ok: false, error: `the setpoint must be between ${SETPOINT_MIN} and ${SETPOINT_MAX} °C` };
    }
    return { ok: true, celsius: roundSetpoint(n) };
}

/**
 * Parameters for an acknowledged Generic Level Set.
 *
 * @param celsius Setpoint on the device grid
 * @param tid Transaction identifier (0..255)
 */
export function levelSetParams(celsius: number, tid: number): Buffer {
    const p = Buffer.alloc(3);
    p.writeInt16LE(celsiusToLevel(celsius), 0);
    p[2] = tid & 0xff;
    return p;
}

/** Parameters for a Sensor Get of the room temperature */
export function sensorGetParams(): Buffer {
    const p = Buffer.alloc(2);
    p.writeUInt16LE(PROPERTY_TEMPERATURE_8, 0);
    return p;
}

/** A value reported by a thermostat */
export type ThermostatUpdate =
    | { address: number; field: 'setpoint'; value: number }
    | { address: number; field: 'heating'; value: boolean }
    | { address: number; field: 'temperature'; value: number }
    | { address: number; field: 'mode'; value: number };

function parseSensorStatus(params: Buffer): Map<number, Buffer> {
    const out = new Map<number, Buffer>();
    let i = 0;
    while (i < params.length) {
        let length: number;
        let property: number;
        if ((params[i] & 0x01) === 0) {
            if (i + 2 > params.length) {
                break;
            }
            const v = params.readUInt16LE(i);
            length = ((v >> 1) & 0x0f) + 1;
            property = v >> 5;
            i += 2;
        } else {
            if (i + 3 > params.length) {
                break;
            }
            length = (params[i] >> 1) + 1;
            property = params.readUInt16LE(i + 1);
            i += 3;
        }
        if (i + length > params.length) {
            break;
        }
        out.set(property, params.subarray(i, i + length));
        i += length;
    }
    return out;
}

/**
 * Maps an access message to thermostat values. Unknown messages give an empty list.
 *
 * @param message Decoded access message
 * @param thermostats Known thermostats
 */
export function interpret(message: AccessMessage, thermostats: ThermostatInfo[]): ThermostatUpdate[] {
    const t = thermostats.find(
        x =>
            message.src === x.levelAddress ||
            message.src === x.onOffAddress ||
            message.src === x.sensorAddress ||
            message.src === x.address,
    );
    if (!t) {
        return [];
    }
    const p = message.params;
    switch (message.opcode) {
        case OP_GENERIC_LEVEL_STATUS:
            if (message.src !== t.levelAddress || p.length < 2) {
                return [];
            }
            // with a transition the target level follows the present level
            return [
                {
                    address: t.address,
                    field: 'setpoint',
                    value: levelToCelsius(p.length >= 4 ? p.readInt16LE(2) : p.readInt16LE(0)),
                },
            ];
        case OP_GENERIC_ONOFF_STATUS:
            if (message.src !== t.onOffAddress || p.length < 1) {
                return [];
            }
            return [{ address: t.address, field: 'heating', value: (p.length >= 2 ? p[1] : p[0]) === 1 }];
        case OP_SENSOR_STATUS: {
            if (message.src !== t.sensorAddress) {
                return [];
            }
            const raw = parseSensorStatus(p).get(PROPERTY_TEMPERATURE_8);
            if (!raw || raw.length !== 1 || raw[0] === 0x7f) {
                return []; // 0x7F = value unknown
            }
            return [{ address: t.address, field: 'temperature', value: raw.readInt8(0) * 0.5 }];
        }
        case OP_JUNG_ADMIN_STATUS: {
            // observed layout (11.11.2026): property id (2 bytes LE), 0x03, value (e.g. 0b 12 03 01 = comfort)
            if (p.length < 4 || p.readUInt16LE(0) !== PROPERTY_JUNG_OPERATING_MODE) {
                return [];
            }
            return [{ address: t.address, field: 'mode', value: p[3] }];
        }
        default:
            return [];
    }
}
