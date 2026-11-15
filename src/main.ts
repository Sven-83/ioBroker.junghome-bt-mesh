/*
 * ioBroker adapter junghome-bt-mesh
 * JUNG HOME room thermostats over Bluetooth Mesh through ESPHome Bluetooth proxies.
 */
import * as utils from '@iobroker/adapter-core';
import { Connection } from '@2colors/esphome-native-api';
import { boostAfterReport, boostRemaining, parseBoost, startBoost, type BoostState } from './lib/boost';
import { temperatureColor } from './lib/color';
import { checkConfig, type CheckedConfig } from './lib/config';
import { MeshCodec, PROXY_TYPE_CONFIG, PROXY_TYPE_NETWORK, type MeshEvent } from './lib/mesh-codec';
import { checkOwnAddress, parseMeshExport, type ThermostatInfo } from './lib/mesh-export';
import { MeshLink, type ApiConnection, type ProxyConfig } from './lib/mesh-link';
import { SeqAllocator } from './lib/seq';
import {
    OP_GENERIC_LEVEL_GET,
    OP_GENERIC_LEVEL_SET,
    OP_GENERIC_ONOFF_GET,
    OP_SENSOR_GET,
    interpret,
    levelSetParams,
    roundSetpoint,
    sensorGetParams,
    validateSetpoint,
    type ThermostatUpdate,
} from './lib/thermostat';

const CONFIRM_TIMEOUT_MS = 4_000;
const MESSAGE_GAP_MS = 300;

/** Runtime values of one thermostat */
interface Room {
    info: ThermostatInfo;
    id: string;
    setpoint: number | null;
    deviceTemperature: number | null;
    leadSensor: string;
    leadTemperature: number | null;
    boost: BoostState | null;
    boostTimer: ioBroker.Timeout | undefined;
    pendingSetpoint: { celsius: number; resolve: (ok: boolean) => void } | null;
}

class JunghomeBtMesh extends utils.Adapter {
    private cfg: CheckedConfig | null = null;
    private codec: MeshCodec | null = null;
    private link: MeshLink | null = null;
    private seq: SeqAllocator | null = null;
    private readonly rooms = new Map<number, Room>();
    private pollTimer: ioBroker.Timeout | undefined;
    private tid = Math.floor(Math.random() * 256);
    private unloading = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'junghome-bt-mesh' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.createInfoObjects();
        await this.setState('info.connection', { val: false, ack: true });

        const { config, errors } = checkConfig(this.config);
        if (errors.length) {
            for (const e of errors) {
                this.log.error(`Configuration: ${e}`);
            }
            return;
        }
        let exp;
        try {
            exp = parseMeshExport(this.config.meshExport);
        } catch (e) {
            this.log.error(`Configuration: ${(e as Error).message}`);
            return;
        }
        const addrError = checkOwnAddress(config.ownAddress, exp);
        if (addrError) {
            this.log.error(`Configuration: ${addrError}`);
            return;
        }
        if (!exp.thermostats.length) {
            this.log.error('Configuration: the export contains no JUNG HOME room thermostat');
            return;
        }
        this.cfg = config;

        const reserveState = await this.getStateAsync('info.seqReserve');
        const ivState = await this.getStateAsync('info.ivIndex');
        this.seq = new SeqAllocator(Number(reserveState?.val) || 0, reserve => {
            this.setState('info.seqReserve', { val: reserve, ack: true }).catch(e =>
                this.log.error(`Cannot store the sequence number: ${(e as Error).message}`),
            );
        });
        const storedIv = Number(ivState?.val);
        this.codec = new MeshCodec({
            netKey: exp.netKey,
            appKey: exp.appKey,
            deviceKeys: exp.deviceKeys,
            ownAddress: config.ownAddress,
            ivIndex: Number.isInteger(storedIv) && storedIv > exp.ivIndex ? storedIv : exp.ivIndex,
            nextSeq: () => this.seq!.take(),
        });
        // persist a fresh reserve right away so a crash during start-up never reuses numbers
        await this.setState('info.seqReserve', { val: this.seq.reserve, ack: true });

        for (const t of exp.thermostats) {
            await this.createRoom(t);
        }
        await this.cleanupRooms();
        this.subscribeStates('thermostats.*');

        this.link = new MeshLink(
            config.proxies,
            exp.thermostats.map(t => t.mac),
            (p: ProxyConfig) =>
                new Connection({
                    host: p.host,
                    port: p.port,
                    encryptionKey: p.encryptionKey || undefined,
                    clientInfo: 'ioBroker.junghome-bt-mesh',
                    reconnect: false,
                }) as unknown as ApiConnection,
            {
                setTimeout: (cb, ms) => this.setTimeout(cb, ms),
                clearTimeout: h => this.clearTimeout(h as ioBroker.Timeout),
                now: () => Date.now(),
            },
            this.log,
        );
        this.link.on('ready', (host: string, _mac: string, rssi: number) => void this.onLinkReady(host, rssi));
        this.link.on('down', () => void this.onLinkDown());
        this.link.on('pdu', (type: number, pdu: Buffer) => this.onPdu(type, pdu));
        this.log.info(`Found ${exp.thermostats.length} thermostat(s), connecting to the mesh`);
        this.link.start();
    }

    // ---------- objects ----------

    private async createInfoObjects(): Promise<void> {
        await this.extendObject('info', { type: 'channel', common: { name: 'Information' }, native: {} });
        const defs: Array<[string, ioBroker.StateCommon]> = [
            [
                'connection',
                {
                    name: 'Connected to the mesh',
                    type: 'boolean',
                    role: 'indicator.connected',
                    read: true,
                    write: false,
                    def: false,
                },
            ],
            [
                'proxy',
                { name: 'ESPHome proxy in use', type: 'string', role: 'text', read: true, write: false, def: '' },
            ],
            [
                'rssi',
                {
                    name: 'Signal of the mesh node at the proxy',
                    type: 'number',
                    role: 'value',
                    unit: 'dBm',
                    read: true,
                    write: false,
                },
            ],
            ['ivIndex', { name: 'Mesh IV index', type: 'number', role: 'value', read: true, write: false, def: 0 }],
            [
                'seqReserve',
                {
                    name: 'Reserved sequence numbers (internal)',
                    type: 'number',
                    role: 'value',
                    read: true,
                    write: false,
                    def: 0,
                },
            ],
        ];
        for (const [id, common] of defs) {
            await this.extendObject(`info.${id}`, { type: 'state', common, native: {} });
        }
    }

    private async createRoom(t: ThermostatInfo): Promise<void> {
        const id = `thermostats.${t.address.toString(16).toUpperCase().padStart(4, '0')}`;
        await this.extendObject('thermostats', { type: 'folder', common: { name: 'Thermostats' }, native: {} });
        await this.extendObject(id, { type: 'channel', common: { name: t.name }, native: { address: t.address } });
        const states: Array<[string, ioBroker.StateCommon]> = [
            [
                'temperature',
                {
                    name: 'Room temperature (lead sensor or thermostat)',
                    type: 'number',
                    role: 'value.temperature',
                    unit: '°C',
                    read: true,
                    write: false,
                },
            ],
            [
                'thermostatTemperature',
                {
                    name: 'Temperature measured by the thermostat',
                    type: 'number',
                    role: 'value.temperature',
                    unit: '°C',
                    read: true,
                    write: false,
                },
            ],
            [
                'setpoint',
                {
                    name: 'Setpoint',
                    type: 'number',
                    role: 'level.temperature',
                    unit: '°C',
                    min: 5,
                    max: 30,
                    step: 0.5,
                    read: true,
                    write: true,
                },
            ],
            [
                'heating',
                { name: 'Heating output active', type: 'boolean', role: 'indicator.working', read: true, write: false },
            ],
            ['mode', { name: 'Operating mode (JUNG)', type: 'number', role: 'value', read: true, write: false }],
            ['boost', { name: 'Boost', type: 'boolean', role: 'switch.boost', read: true, write: true, def: false }],
            [
                'boostUntil',
                { name: 'Boost ends at', type: 'number', role: 'value.time', read: true, write: false, def: 0 },
            ],
            [
                'boostState',
                { name: 'Boost data (internal)', type: 'string', role: 'json', read: true, write: false, def: '' },
            ],
            [
                'leadSensor',
                {
                    name: 'Lead sensor (object ID of a temperature state)',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: true,
                    def: '',
                },
            ],
            [
                'color',
                {
                    name: 'Colour for the floor plan',
                    type: 'string',
                    role: 'level.color.rgb',
                    read: true,
                    write: false,
                    def: '',
                },
            ],
            [
                'lastSeen',
                {
                    name: 'Last message from the thermostat',
                    type: 'number',
                    role: 'value.time',
                    read: true,
                    write: false,
                    def: 0,
                },
            ],
        ];
        for (const [sid, common] of states) {
            await this.extendObject(`${id}.${sid}`, { type: 'state', common, native: {} });
        }
        const lead = await this.getStateAsync(`${id}.leadSensor`);
        const boostRaw = await this.getStateAsync(`${id}.boostState`);
        const setpoint = await this.getStateAsync(`${id}.setpoint`);
        const room: Room = {
            info: t,
            id,
            setpoint: typeof setpoint?.val === 'number' ? setpoint.val : null,
            deviceTemperature: null,
            leadSensor: typeof lead?.val === 'string' ? lead.val : '',
            leadTemperature: null,
            boost: parseBoost(boostRaw?.val),
            boostTimer: undefined,
            pendingSetpoint: null,
        };
        this.rooms.set(t.address, room);
        if (room.leadSensor) {
            await this.attachLeadSensor(room, room.leadSensor);
        }
        if (room.boost) {
            this.armBoostTimer(room);
        }
    }

    /** Removes channels of thermostats that are no longer in the export */
    private async cleanupRooms(): Promise<void> {
        const objs = await this.getObjectViewAsync('system', 'channel', {
            startkey: `${this.namespace}.thermostats.`,
            endkey: `${this.namespace}.thermostats.香`,
        });
        const known = new Set([...this.rooms.values()].map(r => `${this.namespace}.${r.id}`));
        for (const row of objs.rows) {
            if (!known.has(row.id)) {
                this.log.info(`Removing ${row.id}: the thermostat is no longer in the export`);
                await this.delObjectAsync(row.id, { recursive: true });
            }
        }
    }

    // ---------- mesh ----------

    private async onLinkReady(host: string, rssi: number): Promise<void> {
        try {
            await this.link!.send(PROXY_TYPE_CONFIG, this.codec!.encodeFilterAcceptAll());
            await this.setState('info.proxy', { val: host, ack: true });
            await this.setState('info.rssi', { val: rssi, ack: true });
            await this.setState('info.connection', { val: true, ack: true });
            for (const room of this.rooms.values()) {
                if (room.boost && boostRemaining(room.boost, Date.now()) === 0) {
                    await this.endBoost(room, 'time is up');
                }
            }
            await this.pollAll();
        } catch (e) {
            this.log.warn(`Mesh start-up failed: ${(e as Error).message}`);
        }
    }

    private async onLinkDown(): Promise<void> {
        if (this.pollTimer) {
            this.clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
        if (!this.unloading) {
            await this.setState('info.connection', { val: false, ack: true });
        }
    }

    private onPdu(type: number, pdu: Buffer): void {
        let events: MeshEvent[];
        try {
            events = this.codec!.handle(type, pdu, Date.now());
        } catch (e) {
            this.log.debug(`Mesh PDU ignored: ${(e as Error).message}`);
            return;
        }
        for (const ev of events) {
            if (ev.kind === 'beacon') {
                void this.setState('info.ivIndex', { val: this.codec!.ivIndex, ack: true });
            } else if (ev.kind === 'filterStatus') {
                this.log.debug(`Proxy filter: ${ev.acceptList ? 'accept list' : 'reject list (receive all)'}`);
            } else {
                for (const u of interpret(
                    ev.message,
                    [...this.rooms.values()].map(r => r.info),
                )) {
                    void this.applyUpdate(u);
                }
            }
        }
    }

    private async applyUpdate(u: ThermostatUpdate): Promise<void> {
        const room = this.rooms.get(u.address);
        if (!room) {
            return;
        }
        try {
            await this.setState(`${room.id}.lastSeen`, { val: Date.now(), ack: true });
            switch (u.field) {
                case 'setpoint': {
                    room.setpoint = u.value;
                    // a value we are waiting for is our own command, not a manual change
                    const pending = room.pendingSetpoint;
                    if (pending && Math.abs(pending.celsius - u.value) < 0.01) {
                        pending.resolve(true);
                        room.pendingSetpoint = null;
                    } else if (
                        room.boost &&
                        !room.pendingSetpoint &&
                        boostAfterReport(room.boost, u.value) === 'cancel'
                    ) {
                        this.log.info(
                            `${room.info.name}: setpoint changed during the boost, boost ends without restore`,
                        );
                        await this.clearBoost(room);
                    }
                    await this.setState(`${room.id}.setpoint`, { val: u.value, ack: true });
                    break;
                }
                case 'heating':
                    await this.setState(`${room.id}.heating`, { val: u.value, ack: true });
                    break;
                case 'mode':
                    await this.setState(`${room.id}.mode`, { val: u.value, ack: true });
                    break;
                case 'temperature':
                    room.deviceTemperature = u.value;
                    await this.setState(`${room.id}.thermostatTemperature`, { val: u.value, ack: true });
                    await this.publishTemperature(room);
                    break;
            }
        } catch (e) {
            this.log.warn(`Cannot store a value of ${room.id}: ${(e as Error).message}`);
        }
    }

    private async send(dst: number, opcode: number, params?: Buffer): Promise<void> {
        if (!this.link?.ready || !this.codec) {
            throw new Error('not connected to the mesh');
        }
        await this.link.send(PROXY_TYPE_NETWORK, this.codec.encodeAccess(dst, opcode, params));
    }

    private async pollAll(): Promise<void> {
        if (this.pollTimer) {
            this.clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
        for (const room of this.rooms.values()) {
            try {
                await this.send(room.info.levelAddress, OP_GENERIC_LEVEL_GET);
                await this.delay(MESSAGE_GAP_MS);
                await this.send(room.info.onOffAddress, OP_GENERIC_ONOFF_GET);
                await this.delay(MESSAGE_GAP_MS);
                await this.send(room.info.sensorAddress, OP_SENSOR_GET, sensorGetParams());
                await this.delay(MESSAGE_GAP_MS);
            } catch (e) {
                this.log.debug(`Poll of ${room.id} failed: ${(e as Error).message}`);
            }
        }
        if (this.link?.ready && this.cfg) {
            this.pollTimer = this.setTimeout(() => void this.pollAll(), this.cfg.pollMs);
        }
    }

    /**
     * Writes a setpoint and waits for the status of the thermostat. One retry.
     *
     * @param room Thermostat
     * @param celsius Setpoint on the device grid
     */
    private async writeSetpoint(room: Room, celsius: number): Promise<boolean> {
        for (let attempt = 1; attempt <= 2; attempt++) {
            const confirmed = new Promise<boolean>(resolve => {
                room.pendingSetpoint?.resolve(false);
                room.pendingSetpoint = { celsius, resolve };
            });
            const timer = this.setTimeout(() => room.pendingSetpoint?.resolve(false), CONFIRM_TIMEOUT_MS);
            this.tid = (this.tid + 1) & 0xff;
            try {
                await this.send(room.info.levelAddress, OP_GENERIC_LEVEL_SET, levelSetParams(celsius, this.tid));
            } catch (e) {
                this.clearTimeout(timer);
                room.pendingSetpoint = null;
                this.log.warn(`${room.info.name}: setpoint not sent: ${(e as Error).message}`);
                return false;
            }
            const ok = await confirmed;
            this.clearTimeout(timer);
            room.pendingSetpoint = null;
            if (ok) {
                return true;
            }
        }
        this.log.warn(`${room.info.name}: the thermostat did not confirm the setpoint ${celsius} °C`);
        return false;
    }

    // ---------- lead sensor ----------

    private async attachLeadSensor(room: Room, id: string): Promise<boolean> {
        if (room.leadSensor && room.leadSensor !== id && !this.leadSensorUsedElsewhere(room, room.leadSensor)) {
            await this.unsubscribeForeignStatesAsync(room.leadSensor);
        }
        room.leadSensor = id;
        room.leadTemperature = null;
        if (!id) {
            await this.publishTemperature(room);
            return true;
        }
        const obj = await this.getForeignObjectAsync(id);
        if (!obj || obj.type !== 'state') {
            this.log.warn(`${room.info.name}: lead sensor ${id} does not exist, using the thermostat`);
            room.leadSensor = '';
            await this.publishTemperature(room);
            return false;
        }
        await this.subscribeForeignStatesAsync(id);
        const st = await this.getForeignStateAsync(id);
        room.leadTemperature = typeof st?.val === 'number' && Number.isFinite(st.val) ? st.val : null;
        await this.publishTemperature(room);
        return true;
    }

    private leadSensorUsedElsewhere(room: Room, id: string): boolean {
        return [...this.rooms.values()].some(r => r !== room && r.leadSensor === id);
    }

    private async publishTemperature(room: Room): Promise<void> {
        const t = room.leadSensor && room.leadTemperature !== null ? room.leadTemperature : room.deviceTemperature;
        if (t === null) {
            return;
        }
        await this.setState(`${room.id}.temperature`, { val: Math.round(t * 10) / 10, ack: true });
        await this.setState(`${room.id}.color`, { val: temperatureColor(t), ack: true });
    }

    // ---------- boost ----------

    private armBoostTimer(room: Room): void {
        if (room.boostTimer) {
            this.clearTimeout(room.boostTimer);
        }
        if (!room.boost) {
            return;
        }
        // keep single timers below the 32-bit limit of setTimeout
        const ms = Math.min(boostRemaining(room.boost, Date.now()), 2 ** 31 - 1);
        room.boostTimer = this.setTimeout(() => {
            room.boostTimer = undefined;
            if (room.boost && boostRemaining(room.boost, Date.now()) > 0) {
                this.armBoostTimer(room);
                return;
            }
            void this.endBoost(room, 'time is up');
        }, ms);
    }

    private async beginBoost(room: Room): Promise<void> {
        if (room.boost) {
            await this.setState(`${room.id}.boost`, { val: true, ack: true });
            return;
        }
        const cfg = this.cfg!;
        const boost = startBoost(Date.now(), room.setpoint, cfg.boostMinutes, cfg.boostSetpoint);
        if (!boost) {
            this.log.warn(`${room.info.name}: boost not started, the current setpoint is not known yet`);
            await this.setState(`${room.id}.boost`, { val: false, ack: true });
            return;
        }
        room.boost = boost;
        await this.setState(`${room.id}.boostState`, { val: JSON.stringify(boost), ack: true });
        const ok = await this.writeSetpoint(room, boost.target);
        if (!ok) {
            await this.clearBoost(room);
            return;
        }
        await this.setState(`${room.id}.boost`, { val: true, ack: true });
        await this.setState(`${room.id}.boostUntil`, { val: boost.until, ack: true });
        this.armBoostTimer(room);
        this.log.info(`${room.info.name}: boost to ${boost.target} °C for ${cfg.boostMinutes} min`);
    }

    private async endBoost(room: Room, why: string): Promise<void> {
        const boost = room.boost;
        if (!boost) {
            return;
        }
        if (!this.link?.ready) {
            // restore when the mesh is back (onLinkReady)
            this.log.info(`${room.info.name}: boost ends (${why}), setpoint is restored after reconnect`);
            return;
        }
        const ok = await this.writeSetpoint(room, boost.previous);
        if (!ok) {
            this.log.warn(
                `${room.info.name}: previous setpoint ${boost.previous} °C could not be restored, retry in 1 min`,
            );
            room.boostTimer = this.setTimeout(() => void this.endBoost(room, why), 60_000);
            return;
        }
        this.log.info(`${room.info.name}: boost ended (${why}), back to ${boost.previous} °C`);
        await this.clearBoost(room);
    }

    private async clearBoost(room: Room): Promise<void> {
        if (room.boostTimer) {
            this.clearTimeout(room.boostTimer);
            room.boostTimer = undefined;
        }
        room.boost = null;
        await this.setState(`${room.id}.boostState`, { val: '', ack: true });
        await this.setState(`${room.id}.boost`, { val: false, ack: true });
        await this.setState(`${room.id}.boostUntil`, { val: 0, ack: true });
    }

    // ---------- state changes ----------

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state) {
            return;
        }
        try {
            if (!id.startsWith(`${this.namespace}.`)) {
                await this.onForeignState(id, state);
                return;
            }
            if (state.ack) {
                return;
            }
            const m = /^thermostats\.([0-9A-F]{4})\.(setpoint|boost|leadSensor)$/.exec(
                id.slice(this.namespace.length + 1),
            );
            const room = m ? this.rooms.get(parseInt(m[1], 16)) : undefined;
            if (!m || !room) {
                return;
            }
            if (m[2] === 'setpoint') {
                await this.onSetpointCommand(room, state.val);
            } else if (m[2] === 'boost') {
                if (state.val === true || state.val === 'true' || state.val === 1) {
                    await this.beginBoost(room);
                } else {
                    await this.endBoost(room, 'switched off');
                    if (!room.boost) {
                        await this.setState(`${room.id}.boost`, { val: false, ack: true });
                    }
                }
            } else {
                const target = typeof state.val === 'string' ? state.val.trim() : '';
                await this.attachLeadSensor(room, target);
                await this.setState(`${room.id}.leadSensor`, { val: room.leadSensor, ack: true });
            }
        } catch (e) {
            this.log.warn(`Command ${id} failed: ${(e as Error).message}`);
        }
    }

    private async onSetpointCommand(room: Room, value: unknown): Promise<void> {
        const restore = async (): Promise<void> => {
            if (room.setpoint !== null) {
                await this.setState(`${room.id}.setpoint`, { val: room.setpoint, ack: true });
            }
        };
        const v = validateSetpoint(value);
        if (!v.ok) {
            this.log.warn(`${room.info.name}: ${v.error}`);
            await restore();
            return;
        }
        if (room.boost) {
            this.log.info(`${room.info.name}: manual setpoint during the boost, boost ends without restore`);
            await this.clearBoost(room);
        }
        const ok = await this.writeSetpoint(room, roundSetpoint(v.celsius));
        if (!ok) {
            await restore();
        }
    }

    private async onForeignState(id: string, state: ioBroker.State): Promise<void> {
        for (const room of this.rooms.values()) {
            if (room.leadSensor === id) {
                room.leadTemperature = typeof state.val === 'number' && Number.isFinite(state.val) ? state.val : null;
                await this.publishTemperature(room);
            }
        }
    }

    private async onUnload(callback: () => void): Promise<void> {
        this.unloading = true;
        try {
            if (this.pollTimer) {
                this.clearTimeout(this.pollTimer);
            }
            for (const room of this.rooms.values()) {
                if (room.boostTimer) {
                    this.clearTimeout(room.boostTimer);
                }
                room.pendingSetpoint?.resolve(false);
            }
            await this.link?.stop();
            await this.setState('info.connection', { val: false, ack: true });
        } catch {
            // ignore during shutdown
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new JunghomeBtMesh(options);
} else {
    (() => new JunghomeBtMesh())();
}
