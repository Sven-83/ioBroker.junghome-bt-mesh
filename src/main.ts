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
import { knownUsers, telegramPayload } from './lib/telegram';
import {
    REJOIN_PREFIX,
    leaveSetback,
    manualChangeText,
    parseReturnAt,
    parseVacation,
    parseVacationCommand,
    planSetback,
    preheatFrom,
    rejoinButton,
    rejoinPrevious,
    rejoinText,
    statusText,
    vacationAfterReport,
    vacationDue,
    type VacationState,
} from './lib/vacation';

const CONFIRM_TIMEOUT_MS = 4_000;
const MESSAGE_GAP_MS = 300;
const NOTIFY_TIMEOUT_MS = 15_000;

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
    private vacation: VacationState | null = null;
    private vacationTimer: ioBroker.Timeout | undefined;
    private vacationBusy = false;
    private telegramRequestId = '';
    private german = true;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'junghome-bt-mesh' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.createInfoObjects();
        await this.setState('info.connection', { val: false, ack: true });

        const { config, errors, warnings } = checkConfig(this.config);
        for (const w of warnings) {
            this.log.warn(`Configuration: ${w}`);
        }
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
        try {
            const sys = await this.getForeignObjectAsync('system.config');
            this.german = (sys?.common as { language?: string } | undefined)?.language !== 'en';
        } catch {
            // keep German
        }

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
        await this.createVacationObjects();
        this.subscribeStates('thermostats.*');
        this.subscribeStates('vacation.*');
        if (config.notifyInstance) {
            this.telegramRequestId = `${config.notifyInstance}.communicate.request`;
            await this.subscribeForeignStatesAsync(this.telegramRequestId);
        }

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
                // the adapter refuses timers while it shuts down; the short, bounded timeouts of the
                // GATT disconnect then use a plain timer so the shutdown never waits forever
                setTimeout: (cb, ms) =>
                    this.unloading ? { shutdownTimer: setTimeout(cb, Math.min(ms, 3_000)) } : this.setTimeout(cb, ms),
                clearTimeout: h => {
                    if (h && typeof h === 'object' && 'shutdownTimer' in h) {
                        clearTimeout((h as { shutdownTimer: NodeJS.Timeout }).shutdownTimer);
                    } else {
                        this.clearTimeout(h as ioBroker.Timeout);
                    }
                },
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
                'vacation',
                {
                    name: 'In the vacation setback (true = rejoin, false = leave)',
                    type: 'boolean',
                    role: 'switch',
                    read: true,
                    write: true,
                    def: false,
                },
            ],
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

    private async createVacationObjects(): Promise<void> {
        await this.extendObject('vacation', { type: 'channel', common: { name: 'Vacation setback' }, native: {} });
        const defs: Array<[string, ioBroker.StateCommon]> = [
            [
                'active',
                {
                    name: 'Vacation setback active',
                    type: 'boolean',
                    role: 'switch',
                    read: true,
                    write: true,
                    def: false,
                },
            ],
            [
                'returnAt',
                {
                    name: 'Return (ms, ISO date or DD.MM.YYYY; 0 = until switched off)',
                    type: 'number',
                    role: 'date',
                    read: true,
                    write: true,
                    def: 0,
                },
            ],
            [
                'preheatFrom',
                {
                    name: 'Previous setpoints come back at',
                    type: 'number',
                    role: 'value.time',
                    read: true,
                    write: false,
                    def: 0,
                },
            ],
            ['rooms', { name: 'Lowered thermostats', type: 'number', role: 'value', read: true, write: false, def: 0 }],
            [
                'state',
                { name: 'Vacation data (internal)', type: 'string', role: 'json', read: true, write: false, def: '' },
            ],
        ];
        for (const [sid, common] of defs) {
            await this.extendObject(`vacation.${sid}`, { type: 'state', common, native: {} });
        }
        const raw = await this.getStateAsync('vacation.state');
        this.vacation = parseVacation(raw?.val);
        if (this.vacation) {
            const known = new Set([...this.rooms.values()].map(r => r.id));
            for (const id of Object.keys(this.vacation.rooms)) {
                if (!known.has(id)) {
                    delete this.vacation.rooms[id];
                }
            }
            await this.saveVacation();
            this.armVacationTimer();
        } else {
            await this.setState('vacation.active', { val: false, ack: true });
            await this.setState('vacation.preheatFrom', { val: 0, ack: true });
            await this.setState('vacation.rooms', { val: 0, ack: true });
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
            if (this.vacation && vacationDue(this.vacation, Date.now())) {
                await this.endVacation('pre-heating before the return');
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
                    } else if (!room.pendingSetpoint) {
                        // a change by hand at the thermostat
                        if (
                            this.vacation &&
                            vacationAfterReport(this.vacation, room.id, u.value, room.boost?.target ?? null) ===
                                'manual'
                        ) {
                            await this.leaveVacation(room, u.value, true);
                        }
                        if (room.boost && boostAfterReport(room.boost, u.value) === 'cancel') {
                            this.log.info(
                                `${room.info.name}: setpoint changed during the boost, boost ends without restore`,
                            );
                            await this.clearBoost(room);
                        }
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

    // ---------- vacation ----------

    private t(de: string, en: string): string {
        return this.german ? de : en;
    }

    private async saveVacation(): Promise<void> {
        const v = this.vacation;
        await this.setState('vacation.state', { val: v ? JSON.stringify(v) : '', ack: true });
        await this.setState('vacation.active', { val: !!v, ack: true });
        if (v) {
            await this.setState('vacation.returnAt', { val: v.returnAt, ack: true });
        }
        await this.setState('vacation.preheatFrom', { val: v ? preheatFrom(v) : 0, ack: true });
        await this.setState('vacation.rooms', { val: v ? Object.keys(v.rooms).length : 0, ack: true });
        for (const room of this.rooms.values()) {
            await this.setState(`${room.id}.vacation`, { val: !!v && room.id in v.rooms, ack: true });
        }
    }

    private armVacationTimer(): void {
        if (this.vacationTimer) {
            this.clearTimeout(this.vacationTimer);
            this.vacationTimer = undefined;
        }
        const v = this.vacation;
        if (!v || v.returnAt === 0 || this.unloading) {
            return;
        }
        // keep single timers below the 32-bit limit of setTimeout
        const ms = Math.min(Math.max(0, preheatFrom(v) - Date.now()), 2 ** 31 - 1);
        this.vacationTimer = this.setTimeout(() => {
            this.vacationTimer = undefined;
            if (this.vacation && !vacationDue(this.vacation, Date.now())) {
                this.armVacationTimer();
                return;
            }
            void this.endVacation('pre-heating before the return');
        }, ms);
    }

    /**
     * Runs one vacation command at a time.
     *
     * @param job Command
     */
    private async exclusive<T>(job: () => Promise<T>): Promise<T | undefined> {
        if (this.vacationBusy) {
            this.log.warn('Vacation setback: still busy with the last command, please try again');
            return undefined;
        }
        this.vacationBusy = true;
        try {
            return await job();
        } finally {
            this.vacationBusy = false;
        }
    }

    private async onVacationCommand(id: 'vacation.active' | 'vacation.returnAt', value: unknown): Promise<void> {
        const done = await this.exclusive(async () => {
            if (id === 'vacation.returnAt') {
                await this.onReturnAtCommand(value);
            } else if (value === true || value === 'true' || value === 1) {
                const ret = await this.getStateAsync('vacation.returnAt');
                const parsed = parseReturnAt(ret?.val ?? 0, Date.now());
                if (!parsed.ok) {
                    this.log.warn(`Vacation setback not started: ${parsed.error}`);
                    await this.setState('vacation.active', { val: false, ack: true });
                } else {
                    await this.beginVacation(parsed.at);
                }
            } else {
                await this.endVacation('switched off');
            }
            return true;
        });
        if (!done) {
            await this.saveVacation();
        }
    }

    private async onReturnAtCommand(value: unknown): Promise<string | null> {
        const r = parseReturnAt(value, Date.now());
        if (!r.ok) {
            this.log.warn(`Vacation setback: ${r.error}`);
            const old = await this.getStateAsync('vacation.returnAt');
            await this.setState('vacation.returnAt', {
                val: this.vacation ? this.vacation.returnAt : typeof old?.val === 'number' ? old.val : 0,
                ack: true,
            });
            return r.error;
        }
        if (!this.vacation) {
            // remembered for the next start
            await this.setState('vacation.returnAt', { val: r.at, ack: true });
            return null;
        }
        this.vacation.returnAt = r.at;
        this.log.info(`Vacation setback: return set to ${r.at ? new Date(r.at).toISOString() : 'open end'}`);
        await this.saveVacation();
        if (vacationDue(this.vacation, Date.now())) {
            await this.endVacation('pre-heating before the return');
        } else {
            this.armVacationTimer();
        }
        return null;
    }

    /**
     * Starts the setback. Returns a reason (German/English for Telegram) when it was not started.
     *
     * @param returnAt Return (ms), 0 = open end
     */
    private async beginVacation(returnAt: number): Promise<string | null> {
        if (this.vacation) {
            await this.saveVacation();
            return null;
        }
        const cfg = this.cfg!;
        const refuse = async (why: string, de: string): Promise<string> => {
            this.log.warn(`Vacation setback not started: ${why}`);
            await this.setState('vacation.active', { val: false, ack: true });
            return this.t(de, why);
        };
        if (!this.link?.ready) {
            return refuse('not connected to the mesh', 'keine Verbindung zu den Thermostaten');
        }
        const draft = { returnAt, preheatHours: cfg.vacationPreheatHours };
        if (vacationDue(draft, Date.now())) {
            return refuse(
                `the return is less than ${cfg.vacationPreheatHours} h away`,
                `die Rückkehr ist weniger als ${cfg.vacationPreheatHours} h entfernt`,
            );
        }
        await this.setState('vacation.returnAt', { val: returnAt, ack: true });
        const rooms = [...this.rooms.values()];
        const plan = planSetback(
            rooms.map(r => ({ id: r.id, setpoint: r.boost ? r.boost.previous : r.setpoint })),
            cfg.vacationSetpoint,
        );
        for (const id of plan.unknown) {
            this.log.warn(`Vacation setback: ${this.nameOf(id)} skipped, its setpoint is not known yet`);
        }
        for (const id of plan.alreadyLow) {
            this.log.info(`Vacation setback: ${this.nameOf(id)} is already at or below ${cfg.vacationSetpoint} °C`);
        }
        // store first, so our own setpoint reports are never taken for a change by hand
        const vacation: VacationState = {
            ...draft,
            target: cfg.vacationSetpoint,
            rooms: { ...plan.lower },
            left: {},
        };
        this.vacation = vacation;
        await this.saveVacation();
        let failed = 0;
        for (const room of rooms) {
            if (!(room.id in plan.lower)) {
                continue;
            }
            if (room.boost) {
                this.log.info(`${room.info.name}: boost ends for the vacation setback`);
                await this.clearBoost(room);
            }
            if (!(await this.writeSetpoint(room, cfg.vacationSetpoint))) {
                failed++;
                delete vacation.rooms[room.id];
            }
        }
        const lowered = Object.keys(vacation.rooms).length;
        if (failed && !lowered) {
            this.vacation = null;
            await this.saveVacation();
            return refuse('no thermostat accepted the setpoint', 'kein Thermostat hat den Sollwert angenommen');
        }
        await this.saveVacation();
        this.armVacationTimer();
        const until = vacation.returnAt
            ? `, previous setpoints come back at ${new Date(preheatFrom(vacation)).toISOString()}`
            : ', until switched off';
        this.log.info(
            `Vacation setback on: ${lowered} thermostat(s) at ${cfg.vacationSetpoint} °C${failed ? `, ${failed} failed` : ''}${until}`,
        );
        return null;
    }

    private async endVacation(why: string): Promise<void> {
        const v = this.vacation;
        if (!v) {
            await this.saveVacation();
            return;
        }
        if (this.vacationTimer) {
            this.clearTimeout(this.vacationTimer);
            this.vacationTimer = undefined;
        }
        if (!this.link?.ready) {
            // restored in onLinkReady once the time has come
            this.log.warn(`Vacation setback ends (${why}) as soon as the mesh is connected again`);
            if (why.startsWith('switched off')) {
                v.returnAt = Date.now();
                v.preheatHours = 0;
            }
            await this.saveVacation();
            return;
        }
        for (const [id, previous] of Object.entries(v.rooms)) {
            const room = [...this.rooms.values()].find(r => r.id === id);
            if (!room) {
                delete v.rooms[id];
                continue;
            }
            if (room.boost) {
                await this.clearBoost(room);
            }
            if (await this.writeSetpoint(room, previous)) {
                delete v.rooms[id];
                await this.saveVacation();
            }
        }
        const left = Object.keys(v.rooms).length;
        if (left) {
            this.log.warn(`Vacation setback: ${left} setpoint(s) could not be restored, retry in 1 min`);
            await this.saveVacation();
            if (!this.unloading) {
                this.vacationTimer = this.setTimeout(() => void this.endVacation(why), 60_000);
            }
            return;
        }
        this.vacation = null;
        await this.saveVacation();
        await this.setState('vacation.returnAt', { val: 0, ack: true });
        this.log.info(`Vacation setback ended (${why})`);
    }

    /**
     * A lowered room was changed by hand: the change counts as intended, the room leaves the setback.
     *
     * @param room Thermostat
     * @param celsius New setpoint
     * @param atDevice Changed at the thermostat (true) or through ioBroker (false)
     */
    private async leaveVacation(room: Room, celsius: number, atDevice: boolean): Promise<void> {
        if (!this.vacation || !leaveSetback(this.vacation, room.id)) {
            return;
        }
        await this.saveVacation();
        this.log.info(
            `${room.info.name}: setpoint ${celsius} °C set by hand during the vacation, the room leaves the setback`,
        );
        void this.notify(manualChangeText(this.german, room.info.name, celsius, atDevice), {
            label: rejoinButton(this.german),
            data: `${REJOIN_PREFIX}${room.id.slice(-4)}`,
        });
    }

    /**
     * Puts a room back into the running setback. Returns the answer for Telegram.
     *
     * @param room Thermostat
     */
    private async rejoinVacation(room: Room): Promise<string> {
        const v = this.vacation;
        const name = room.info.name;
        if (!v) {
            return this.t('🏠 Der Urlaub ist schon vorbei.', '🏠 The vacation is already over.');
        }
        if (room.id in v.rooms) {
            return this.t(
                `${name} ist bereits in der Urlaubsabsenkung.`,
                `${name} is already in the vacation setback.`,
            );
        }
        const previous = rejoinPrevious(v, room.id, room.boost ? room.boost.previous : room.setpoint);
        if (previous === null) {
            return this.t(
                `${name}: kein Sollwert über ${v.target} °C bekannt, nichts abzusenken.`,
                `${name}: no setpoint above ${v.target} °C known, nothing to lower.`,
            );
        }
        if (!this.link?.ready) {
            return this.t(
                `⚠️ ${name}: keine Verbindung zum Thermostat, bitte später noch einmal.`,
                `⚠️ ${name}: no connection to the thermostat, please try again later.`,
            );
        }
        v.rooms[room.id] = previous;
        delete v.left[room.id];
        await this.saveVacation();
        if (room.boost) {
            await this.clearBoost(room);
        }
        if (!(await this.writeSetpoint(room, v.target))) {
            if (this.vacation === v) {
                delete v.rooms[room.id];
                v.left[room.id] = previous;
                await this.saveVacation();
            }
            return this.t(
                `⚠️ ${name}: Das Thermostat hat ${v.target} °C nicht bestätigt.`,
                `⚠️ ${name}: the thermostat did not confirm ${v.target} °C.`,
            );
        }
        this.log.info(`${name}: back in the vacation setback, ${previous} °C comes back at the end`);
        return rejoinText(this.german, name, v.target, previous);
    }

    /**
     * Takes a room out of the setback through its vacation state and restores its previous setpoint.
     *
     * @param room Thermostat
     */
    private async leaveByCommand(room: Room): Promise<void> {
        const v = this.vacation;
        if (!v || !(room.id in v.rooms)) {
            await this.setState(`${room.id}.vacation`, { val: false, ack: true });
            return;
        }
        const previous = v.rooms[room.id];
        if (!(await this.writeSetpoint(room, previous))) {
            await this.saveVacation();
            return;
        }
        leaveSetback(v, room.id);
        await this.saveVacation();
        this.log.info(`${room.info.name}: taken out of the vacation setback, back to ${previous} °C`);
    }

    private nameOf(id: string): string {
        return [...this.rooms.values()].find(r => r.id === id)?.info.name ?? id;
    }

    /**
     * Sends a text through the messenger instance (Telegram) to the configured receivers. Failures are only logged.
     *
     * @param text Message
     * @param button Optional inline button
     * @param button.label Label of the button
     * @param button.data Callback data
     */
    private async notify(text: string, button?: { label: string; data: string }): Promise<void> {
        const cfg = this.cfg;
        if (!cfg?.notifyInstance) {
            return;
        }
        const users = cfg.notifyUsers.length ? cfg.notifyUsers : [''];
        for (const user of users) {
            try {
                await this.sendToAsync(cfg.notifyInstance, 'send', telegramPayload(text, { user }, button), {
                    timeout: NOTIFY_TIMEOUT_MS,
                });
            } catch (e) {
                this.log.warn(`Message via ${cfg.notifyInstance} not sent: ${(e as Error).message}`);
            }
        }
    }

    /**
     * A text or button press arrived at the telegram instance. Only vacation commands of known users are handled.
     *
     * @param request Value of telegram.N.communicate.request
     */
    private async onTelegramRequest(request: unknown): Promise<void> {
        const cmd = parseVacationCommand(request);
        const instance = this.cfg?.notifyInstance;
        if (!cmd || !instance) {
            return;
        }
        const chatId = (await this.getForeignStateAsync(`${instance}.communicate.requestChatId`))?.val;
        const users = knownUsers((await this.getForeignStateAsync(`${instance}.communicate.users`))?.val);
        if ((typeof chatId !== 'number' && typeof chatId !== 'string') || !users.has(String(chatId))) {
            this.log.warn(
                'Vacation setback: Telegram command from a chat the telegram instance does not know, ignored',
            );
            return;
        }
        const reply = async (text: string): Promise<void> => {
            try {
                await this.sendToAsync(instance, 'send', telegramPayload(text, { chatId }), {
                    timeout: NOTIFY_TIMEOUT_MS,
                });
            } catch (e) {
                this.log.warn(`Answer via ${instance} not sent: ${(e as Error).message}`);
            }
        };
        if (cmd.kind === 'rejoin') {
            // stop the spinner on the button
            void this.sendToAsync(
                instance,
                'send',
                { text: '↩️', chatId, answerCallbackQuery: { text: '↩️', showAlert: false } },
                { timeout: NOTIFY_TIMEOUT_MS },
            ).catch(() => undefined);
        }
        const answer = await this.exclusive(async (): Promise<string> => {
            const status = (): string => statusText(this.vacation, this.german, id => this.nameOf(id));
            switch (cmd.kind) {
                case 'status':
                    return status();
                case 'off':
                    if (!this.vacation) {
                        return status();
                    }
                    await this.endVacation('switched off via Telegram');
                    return this.vacation
                        ? this.t(
                              '⚠️ Urlaubsabsenkung endet, sobald die Thermostate wieder erreichbar sind.',
                              '⚠️ The vacation setback ends as soon as the thermostats are reachable again.',
                          )
                        : this.t(
                              '🏠 Urlaubsabsenkung beendet, die vorherigen Sollwerte sind zurück.',
                              '🏠 Vacation setback ended, the previous setpoints are back.',
                          );
                case 'on': {
                    const parsed = cmd.returnAt
                        ? parseReturnAt(cmd.returnAt, Date.now())
                        : { ok: true as const, at: 0 };
                    if (!parsed.ok) {
                        return this.t(
                            `⚠️ Datum nicht verstanden. Beispiele: „Urlaub bis 24.12.“, „Urlaub bis 24.12. 18:00“, „Urlaub“ (ohne Ende).`,
                            `⚠️ Date not understood. Examples: "vacation until 24.12.", "vacation until 24.12. 18:00", "vacation" (no end).`,
                        );
                    }
                    if (this.vacation) {
                        const error = await this.onReturnAtCommand(parsed.at);
                        return error ? `⚠️ ${error}` : status();
                    }
                    const error = await this.beginVacation(parsed.at);
                    return error ? this.t(`⚠️ Nicht gestartet: ${error}`, `⚠️ Not started: ${error}`) : status();
                }
                case 'rejoin': {
                    const room = this.rooms.get(parseInt(cmd.address, 16));
                    return room ? this.rejoinVacation(room) : this.t('Raum unbekannt.', 'Unknown room.');
                }
            }
        });
        await reply(
            answer ??
                this.t(
                    '⏳ Ich bin noch mit dem letzten Befehl beschäftigt, bitte gleich noch einmal.',
                    '⏳ Still busy with the last command, please try again in a moment.',
                ),
        );
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
            const local = id.slice(this.namespace.length + 1);
            if (local === 'vacation.active' || local === 'vacation.returnAt') {
                await this.onVacationCommand(local, state.val);
                return;
            }
            const m = /^thermostats\.([0-9A-F]{4})\.(setpoint|boost|vacation|leadSensor)$/.exec(
                id.slice(this.namespace.length + 1),
            );
            const room = m ? this.rooms.get(parseInt(m[1], 16)) : undefined;
            if (!m || !room) {
                return;
            }
            if (m[2] === 'setpoint') {
                await this.onSetpointCommand(room, state.val);
            } else if (m[2] === 'vacation') {
                const on = state.val === true || state.val === 'true' || state.val === 1;
                const done = await this.exclusive(async () => {
                    if (on) {
                        const answer = await this.rejoinVacation(room);
                        this.log.info(`${room.info.name}: ${answer}`);
                        await this.saveVacation();
                    } else {
                        await this.leaveByCommand(room);
                    }
                    return true;
                });
                if (!done) {
                    await this.saveVacation();
                }
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
        const celsius = roundSetpoint(v.celsius);
        if (room.boost) {
            this.log.info(`${room.info.name}: manual setpoint during the boost, boost ends without restore`);
            await this.clearBoost(room);
        }
        const ok = await this.writeSetpoint(room, celsius);
        if (!ok) {
            await restore();
            return;
        }
        if (this.vacation && room.id in this.vacation.rooms && Math.abs(celsius - this.vacation.target) >= 0.01) {
            await this.leaveVacation(room, celsius, false);
        }
    }

    private async onForeignState(id: string, state: ioBroker.State): Promise<void> {
        if (id === this.telegramRequestId) {
            await this.onTelegramRequest(state.val);
            return;
        }
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
            if (this.vacationTimer) {
                this.clearTimeout(this.vacationTimer);
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
