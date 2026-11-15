/**
 * Validation of the instance configuration.
 */
import type { ProxyConfig } from './mesh-link';

/** Checked configuration */
export interface CheckedConfig {
    /** Own unicast address */
    ownAddress: number;
    /** Proxies in order of preference */
    proxies: ProxyConfig[];
    /** Poll interval in ms */
    pollMs: number;
    /** Boost duration in minutes */
    boostMinutes: number;
    /** Setpoint during a boost in °C */
    boostSetpoint: number;
}

const HOST = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/;

function intIn(value: unknown, min: number, max: number, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function proxy(host: unknown, key: unknown, label: string, errors: string[]): ProxyConfig | null {
    const h = typeof host === 'string' ? host.trim() : '';
    if (!h) {
        return null;
    }
    if (!HOST.test(h)) {
        errors.push(`${label}: "${h}" is not a valid host name or IP address`);
        return null;
    }
    const k = typeof key === 'string' ? key.trim() : '';
    if (k && (!/^[A-Za-z0-9+/]{43}=$/.test(k) || Buffer.from(k, 'base64').length !== 32)) {
        errors.push(
            `${label}: the API encryption key must be the 44-character base64 key from the ESPHome configuration`,
        );
        return null;
    }
    return { host: h, port: 6053, encryptionKey: k };
}

/**
 * Checks the configuration. Returns the checked values or a list of errors (never containing secrets).
 *
 * @param native Instance configuration
 */
export function checkConfig(native: ioBroker.AdapterConfig): { config: CheckedConfig; errors: string[] } {
    const errors: string[] = [];
    const addrText = typeof native.ownAddress === 'string' ? native.ownAddress.trim() : '';
    const ownAddress = /^[0-9a-fA-F]{4}$/.test(addrText) ? parseInt(addrText, 16) : NaN;
    if (Number.isNaN(ownAddress)) {
        errors.push('the own address must be 4 hex digits, e.g. 0D01');
    }
    const proxies = [
        proxy(native.proxy1Host, native.proxy1Key, 'Proxy 1', errors),
        proxy(native.proxy2Host, native.proxy2Key, 'Proxy 2', errors),
    ].filter((p): p is ProxyConfig => p !== null);
    if (!proxies.length && !errors.some(e => e.startsWith('Proxy'))) {
        errors.push('no ESPHome Bluetooth proxy is configured');
    }
    if (typeof native.meshExport !== 'string' || native.meshExport.trim() === '') {
        errors.push('the JUNG HOME project export is missing');
    }
    return {
        config: {
            ownAddress,
            proxies,
            pollMs: intIn(native.pollMinutes, 1, 60, 5) * 60_000,
            boostMinutes: intIn(native.boostMinutes, 5, 240, 60),
            boostSetpoint: intIn(native.boostSetpoint, 5, 30, 30),
        },
        errors,
    };
}
