/**
 * Keeps one GATT connection from an ESPHome Bluetooth proxy to a mesh proxy node (a thermostat).
 * Proxies are tried in the configured order; on failure the next one is used, with exponential backoff.
 */
import { EventEmitter } from 'node:events';
import { ProxyReassembler, segmentProxyPdu } from './proxy-pdu';

/** Settings of one ESPHome proxy */
export interface ProxyConfig {
    /** Host name or IP address */
    host: string;
    /** API port (6053) */
    port: number;
    /** Base64 Noise key, empty for proxies without API encryption */
    encryptionKey: string;
}

/** The part of the ESPHome API connection the link needs (allows a fake in tests) */
export interface ApiConnection {
    /** Opens the connection */
    connect(): void;
    /** Closes the connection */
    disconnect(): void;
    /** Adds an event listener */
    on(event: string, listener: (...args: any[]) => void): unknown;
    /** Adds a one-time event listener */
    once(event: string, listener: (...args: any[]) => void): unknown;
    /** Removes all event listeners */
    removeAllListeners(): unknown;
    /** Starts forwarding BLE advertisements */
    subscribeBluetoothAdvertisementService(): void;
    /** Stops forwarding BLE advertisements */
    unsubscribeBluetoothAdvertisementService(): void;
    /** Opens a GATT connection through the proxy */
    connectBluetoothDeviceService(
        address: number,
        addressType?: number,
        useCache?: boolean,
    ): Promise<{ connected: boolean; mtu: number; error: number }>;
    /** Closes a GATT connection */
    disconnectBluetoothDeviceService(address: number): Promise<unknown>;
    /** Lists GATT services of the connected device */
    listBluetoothGATTServicesService(address: number): Promise<{ servicesList: GattService[] }>;
    /** Writes a GATT characteristic */
    writeBluetoothGATTCharacteristicService(
        address: number,
        handle: number,
        value: Uint8Array,
        response?: boolean,
    ): Promise<unknown>;
    /** Enables notifications of a characteristic */
    notifyBluetoothGATTCharacteristicService(address: number, handle: number): Promise<unknown>;
    /** Writes a GATT descriptor */
    writeBluetoothGATTDescriptorService(address: number, handle: number, value: Uint8Array): Promise<unknown>;
}

/** GATT service as returned by the ESPHome API */
export interface GattService {
    /** UUID (string or number list) */
    uuid?: unknown;
    /** UUID as 128-bit number pair */
    uuidList?: unknown;
    /** 16-bit UUID (newer API versions) */
    shortUuid?: number;
    /** GATT handle */
    handle: number;
    /** Characteristics of the service */
    characteristicsList: Array<{
        uuid?: unknown;
        uuidList?: unknown;
        shortUuid?: number;
        handle: number;
        descriptorsList?: Array<{ uuid?: unknown; uuidList?: unknown; shortUuid?: number; handle: number }>;
    }>;
}

/** Timer functions of the adapter (compact mode safe) */
export interface Scheduler {
    /** Starts a timer */
    setTimeout(cb: () => void, ms: number): unknown;
    /** Stops a timer */
    clearTimeout(handle: unknown): void;
    /** Current time in ms */
    now(): number;
}

/** Log functions */
export interface LinkLog {
    /** Debug log */
    debug(msg: string): void;
    /** Info log */
    info(msg: string): void;
    /** Warning log */
    warn(msg: string): void;
}

const MESH_PROXY_SERVICE = 0x1828;
const MESH_PROXY_DATA_IN = 0x2add;
const MESH_PROXY_DATA_OUT = 0x2ade;
const CCCD = 0x2902;

const API_TIMEOUT_MS = 15_000;
const SCAN_MS = 15_000;
const COLLECT_MS = 1_500;
const GATT_TIMEOUT_MS = 20_000;
const WRITE_TIMEOUT_MS = 3_000;
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;

/**
 * Extracts the 16-bit UUID from the different ESPHome API encodings.
 *
 * @param o Service, characteristic or descriptor
 * @param o.uuid UUID as string or list
 * @param o.uuidList UUID as 128-bit number pair
 * @param o.shortUuid 16-bit UUID (newer API versions)
 */
export function uuid16(o: { uuid?: unknown; uuidList?: unknown; shortUuid?: number }): number {
    if (typeof o.shortUuid === 'number' && o.shortUuid > 0) {
        return o.shortUuid;
    }
    if (typeof o.uuid === 'string' && /^0000[0-9a-f]{4}-0000-1000-8000-00805f9b34fb$/i.test(o.uuid)) {
        return parseInt(o.uuid.slice(4, 8), 16);
    }
    const list = Array.isArray(o.uuidList) && o.uuidList.length ? o.uuidList : Array.isArray(o.uuid) ? o.uuid : null;
    if (list) {
        try {
            return Number((BigInt(String(list[0])) >> 32n) & 0xffffn);
        } catch {
            return -1;
        }
    }
    return -1;
}

/**
 * Next backoff delay.
 *
 * @param attempt Number of failed attempts in a row (1 = first failure)
 */
export function backoffDelay(attempt: number): number {
    return Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.max(0, attempt - 1));
}

const macToNumber = (mac: string): number => parseInt(mac.replace(/:/g, ''), 16);

/**
 * Events: 'ready' (proxyHost, nodeMac, rssi), 'down' (reason), 'pdu' (type, pdu)
 */
export class MeshLink extends EventEmitter {
    private conn: ApiConnection | null = null;
    private connectedMac: number | null = null;
    private attemptMac: number | null = null;
    private dataIn = -1;
    private mtu = 23;
    private attempt = 0;
    private proxyIndex = 0;
    private retryTimer: unknown = null;
    private stopped = true;
    private generation = 0;
    private readonly reassembler = new ProxyReassembler();
    private writeChain: Promise<void> = Promise.resolve();

    /**
     * @param proxies Proxies in order of preference
     * @param nodeMacs MACs of mesh proxy nodes (thermostats)
     * @param createConnection Factory for an ESPHome API connection
     * @param scheduler Adapter timers
     * @param log Adapter log
     */
    public constructor(
        private readonly proxies: ProxyConfig[],
        private readonly nodeMacs: string[],
        private readonly createConnection: (cfg: ProxyConfig) => ApiConnection,
        private readonly scheduler: Scheduler,
        private readonly log: LinkLog,
    ) {
        super();
    }

    /** True when PDUs can be sent */
    public get ready(): boolean {
        return this.connectedMac !== null && this.dataIn >= 0;
    }

    /** Starts connecting */
    public start(): void {
        this.stopped = false;
        this.attempt = 0;
        this.proxyIndex = 0;
        this.scheduleConnect(0);
    }

    /** Closes everything; no reconnect afterwards */
    public async stop(): Promise<void> {
        this.stopped = true;
        if (this.retryTimer) {
            this.scheduler.clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        await this.teardown('stopped', false);
    }

    /**
     * Sends a PDU, segmented to the MTU. Writes are serialised.
     *
     * @param type Proxy PDU type
     * @param pdu Network or proxy configuration PDU
     */
    public send(type: number, pdu: Buffer): Promise<void> {
        const run = async (): Promise<void> => {
            if (!this.ready || !this.conn || this.connectedMac === null) {
                throw new Error('not connected to the mesh');
            }
            for (const part of segmentProxyPdu(type, pdu, this.mtu)) {
                await this.withTimeout(
                    this.conn.writeBluetoothGATTCharacteristicService(
                        this.connectedMac,
                        this.dataIn,
                        new Uint8Array(part),
                        false,
                    ),
                    WRITE_TIMEOUT_MS,
                    'GATT write',
                );
            }
        };
        const result = this.writeChain.then(run, run);
        this.writeChain = result.catch(() => undefined);
        return result;
    }

    private scheduleConnect(ms: number): void {
        if (this.stopped) {
            return;
        }
        this.retryTimer = this.scheduler.setTimeout(() => {
            this.retryTimer = null;
            void this.connectOnce();
        }, ms);
    }

    private async connectOnce(): Promise<void> {
        const gen = ++this.generation;
        const proxy = this.proxies[this.proxyIndex % this.proxies.length];
        try {
            await this.openApi(proxy, gen);
            const node = await this.findNode(gen);
            await this.openGatt(node.mac, node.addressType, gen);
            this.attempt = 0;
            const macText = node.mac
                .toString(16)
                .toUpperCase()
                .padStart(12, '0')
                .replace(/(..)(?!$)/g, '$1:');
            this.log.info(`Connected to the mesh through ${proxy.host} (node ${macText}, RSSI ${node.rssi} dBm)`);
            this.emit('ready', proxy.host, macText, node.rssi);
        } catch (e) {
            if (gen !== this.generation || this.stopped) {
                return;
            }
            this.attempt++;
            const delay = backoffDelay(this.attempt);
            this.log.warn(
                `Mesh connection through ${proxy.host} failed: ${(e as Error).message}; next try in ${Math.round(delay / 1000)} s`,
            );
            await this.teardown((e as Error).message, false);
            if (this.proxies.length > 1) {
                this.proxyIndex = (this.proxyIndex + 1) % this.proxies.length;
            }
            this.scheduleConnect(delay);
        }
    }

    private openApi(proxy: ProxyConfig, gen: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const conn = this.createConnection(proxy);
            this.conn = conn;
            const timer = this.scheduler.setTimeout(() => reject(new Error('ESPHome API timeout')), API_TIMEOUT_MS);
            conn.on('error', (e: Error) => {
                this.log.debug(`ESPHome API ${proxy.host}: ${e?.message ?? String(e)}`);
            });
            conn.on('disconnected', () => {
                this.scheduler.clearTimeout(timer);
                reject(new Error('ESPHome API closed'));
                this.lost(gen, 'ESPHome API connection closed');
            });
            conn.once('authorized', () => {
                this.scheduler.clearTimeout(timer);
                resolve();
            });
            conn.on('message.BluetoothDeviceConnectionResponse', (m: { address: number; connected: boolean }) => {
                if (this.connectedMac !== null && Number(m.address) === this.connectedMac && !m.connected) {
                    this.lost(gen, 'thermostat disconnected');
                }
            });
            conn.on('message.BluetoothGATTNotifyDataResponse', (m: { handle: number; data: unknown }) => {
                if (gen !== this.generation) {
                    return;
                }
                const data =
                    typeof m.data === 'string' ? Buffer.from(m.data, 'base64') : Buffer.from(m.data as Uint8Array);
                const complete = this.reassembler.push(data);
                if (complete) {
                    this.emit('pdu', complete.type, complete.pdu);
                }
            });
            conn.connect();
        });
    }

    /**
     * Waits for advertisements of the known thermostats. Connects right after the first one was seen
     * (with several thermostats, collects for a short moment and takes the strongest).
     * The advertisement subscription stays active while the link exists: the proxy only connects to
     * devices it currently sees, and dropping the subscription before connecting made connects fail.
     *
     * @param gen Connection generation
     */
    private findNode(gen: number): Promise<{ mac: number; addressType: number; rssi: number }> {
        const wanted = new Set(this.nodeMacs.map(macToNumber));
        const best = new Map<number, { addressType: number; rssi: number }>();
        return new Promise((resolve, reject) => {
            const conn = this.conn;
            if (!conn) {
                reject(new Error('no API connection'));
                return;
            }
            let done = false;
            let collectTimer: unknown = null;
            let overall: unknown = null;
            const finish = (): void => {
                if (done) {
                    return;
                }
                done = true;
                this.scheduler.clearTimeout(overall);
                if (collectTimer) {
                    this.scheduler.clearTimeout(collectTimer);
                }
                if (gen !== this.generation) {
                    reject(new Error('superseded'));
                    return;
                }
                const sorted = [...best.entries()].sort((a, b) => b[1].rssi - a[1].rssi);
                if (!sorted.length) {
                    reject(new Error('no JUNG HOME thermostat in range of this proxy'));
                    return;
                }
                resolve({ mac: sorted[0][0], addressType: sorted[0][1].addressType, rssi: sorted[0][1].rssi });
            };
            overall = this.scheduler.setTimeout(finish, SCAN_MS);
            conn.on(
                'message.BluetoothLERawAdvertisementsResponse',
                (m: { advertisementsList?: Array<{ address: unknown; rssi: number; addressType?: number }> }) => {
                    if (done) {
                        return;
                    }
                    for (const a of m.advertisementsList ?? []) {
                        const mac = Number(a.address);
                        if (wanted.has(mac)) {
                            const prev = best.get(mac);
                            if (!prev || a.rssi > prev.rssi) {
                                best.set(mac, { addressType: a.addressType ?? 0, rssi: a.rssi });
                            }
                        }
                    }
                    if (best.size && !collectTimer) {
                        collectTimer = this.scheduler.setTimeout(finish, wanted.size > 1 ? COLLECT_MS : 0);
                    }
                },
            );
            conn.subscribeBluetoothAdvertisementService();
        });
    }

    private async openGatt(mac: number, addressType: number, gen: number): Promise<void> {
        const conn = this.conn;
        if (!conn) {
            throw new Error('no API connection');
        }
        // remember the address before connecting: a timed-out connect may still complete on the
        // proxy and must then be closed again, otherwise the thermostat stays blocked
        this.attemptMac = mac;
        const res = await this.withTimeout(
            conn.connectBluetoothDeviceService(mac, addressType, false),
            GATT_TIMEOUT_MS,
            'GATT connect',
        );
        if (!res.connected) {
            throw new Error(`GATT connect refused (error ${res.error})`);
        }
        if (gen !== this.generation) {
            throw new Error('superseded');
        }
        this.connectedMac = mac;
        this.mtu = res.mtu || 23;
        const { servicesList } = await this.withTimeout(
            conn.listBluetoothGATTServicesService(mac),
            GATT_TIMEOUT_MS,
            'GATT services',
        );
        const svc = servicesList.find(s => uuid16(s) === MESH_PROXY_SERVICE);
        if (!svc) {
            throw new Error('the node offers no Mesh Proxy service');
        }
        const chIn = svc.characteristicsList.find(c => uuid16(c) === MESH_PROXY_DATA_IN);
        const chOut = svc.characteristicsList.find(c => uuid16(c) === MESH_PROXY_DATA_OUT);
        if (!chIn || !chOut) {
            throw new Error('Mesh Proxy characteristics missing');
        }
        await this.withTimeout(
            conn.notifyBluetoothGATTCharacteristicService(mac, chOut.handle),
            GATT_TIMEOUT_MS,
            'GATT notify',
        );
        const cccd = (chOut.descriptorsList ?? []).find(d => uuid16(d) === CCCD);
        if (cccd) {
            await this.withTimeout(
                conn.writeBluetoothGATTDescriptorService(mac, cccd.handle, new Uint8Array([0x01, 0x00])),
                GATT_TIMEOUT_MS,
                'GATT descriptor',
            );
        }
        this.reassembler.reset();
        this.dataIn = chIn.handle;
    }

    private lost(gen: number, reason: string): void {
        // While connecting, failures are handled by connectOnce (timeouts / rejections)
        if (gen !== this.generation || this.stopped || !this.ready) {
            return;
        }
        this.generation++; // ignore late events of this connection
        void this.teardown(reason, true).then(() => {
            this.attempt = 1;
            this.log.warn(`Mesh connection lost: ${reason}; reconnecting`);
            this.scheduleConnect(backoffDelay(1));
        });
    }

    private async teardown(reason: string, emitDown: boolean): Promise<void> {
        const conn = this.conn;
        const mac = this.connectedMac ?? this.attemptMac;
        this.conn = null;
        this.connectedMac = null;
        this.attemptMac = null;
        this.dataIn = -1;
        if (conn) {
            if (mac !== null) {
                await this.withTimeout(conn.disconnectBluetoothDeviceService(mac), 3_000, 'GATT disconnect').catch(
                    () => undefined,
                );
            }
            try {
                conn.removeAllListeners();
                conn.on('error', () => undefined);
                conn.disconnect();
            } catch {
                // ignore
            }
        }
        if (emitDown) {
            this.emit('down', reason);
        }
    }

    private withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = this.scheduler.setTimeout(() => reject(new Error(`${what} timeout`)), ms);
            p.then(
                v => {
                    this.scheduler.clearTimeout(timer);
                    resolve(v);
                },
                (e: unknown) => {
                    this.scheduler.clearTimeout(timer);
                    reject(e instanceof Error ? e : new Error(String(e)));
                },
            );
        });
    }
}
