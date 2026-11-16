"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_esphome_native_api = require("@2colors/esphome-native-api");
var import_boost = require("./lib/boost");
var import_color = require("./lib/color");
var import_config = require("./lib/config");
var import_mesh_codec = require("./lib/mesh-codec");
var import_mesh_export = require("./lib/mesh-export");
var import_mesh_link = require("./lib/mesh-link");
var import_seq = require("./lib/seq");
var import_thermostat = require("./lib/thermostat");
var import_telegram = require("./lib/telegram");
var import_vacation = require("./lib/vacation");
const CONFIRM_TIMEOUT_MS = 4e3;
const MESSAGE_GAP_MS = 300;
const NOTIFY_TIMEOUT_MS = 15e3;
class JunghomeBtMesh extends utils.Adapter {
  cfg = null;
  codec = null;
  link = null;
  seq = null;
  rooms = /* @__PURE__ */ new Map();
  pollTimer;
  tid = Math.floor(Math.random() * 256);
  unloading = false;
  vacation = null;
  vacationTimer;
  vacationBusy = false;
  telegramRequestId = "";
  german = true;
  constructor(options = {}) {
    super({ ...options, name: "junghome-bt-mesh" });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    var _a;
    await this.createInfoObjects();
    await this.setState("info.connection", { val: false, ack: true });
    const { config, errors, warnings } = (0, import_config.checkConfig)(this.config);
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
      exp = (0, import_mesh_export.parseMeshExport)(this.config.meshExport);
    } catch (e) {
      this.log.error(`Configuration: ${e.message}`);
      return;
    }
    const addrError = (0, import_mesh_export.checkOwnAddress)(config.ownAddress, exp);
    if (addrError) {
      this.log.error(`Configuration: ${addrError}`);
      return;
    }
    if (!exp.thermostats.length) {
      this.log.error("Configuration: the export contains no JUNG HOME room thermostat");
      return;
    }
    this.cfg = config;
    try {
      const sys = await this.getForeignObjectAsync("system.config");
      this.german = ((_a = sys == null ? void 0 : sys.common) == null ? void 0 : _a.language) !== "en";
    } catch {
    }
    const reserveState = await this.getStateAsync("info.seqReserve");
    const ivState = await this.getStateAsync("info.ivIndex");
    this.seq = new import_seq.SeqAllocator(Number(reserveState == null ? void 0 : reserveState.val) || 0, (reserve) => {
      this.setState("info.seqReserve", { val: reserve, ack: true }).catch(
        (e) => this.log.error(`Cannot store the sequence number: ${e.message}`)
      );
    });
    const storedIv = Number(ivState == null ? void 0 : ivState.val);
    this.codec = new import_mesh_codec.MeshCodec({
      netKey: exp.netKey,
      appKey: exp.appKey,
      deviceKeys: exp.deviceKeys,
      ownAddress: config.ownAddress,
      ivIndex: Number.isInteger(storedIv) && storedIv > exp.ivIndex ? storedIv : exp.ivIndex,
      nextSeq: () => this.seq.take()
    });
    await this.setState("info.seqReserve", { val: this.seq.reserve, ack: true });
    for (const t of exp.thermostats) {
      await this.createRoom(t);
    }
    await this.cleanupRooms();
    await this.createVacationObjects();
    this.subscribeStates("thermostats.*");
    this.subscribeStates("vacation.*");
    if (config.notifyInstance) {
      this.telegramRequestId = `${config.notifyInstance}.communicate.request`;
      await this.subscribeForeignStatesAsync(this.telegramRequestId);
    }
    this.link = new import_mesh_link.MeshLink(
      config.proxies,
      exp.thermostats.map((t) => t.mac),
      (p) => new import_esphome_native_api.Connection({
        host: p.host,
        port: p.port,
        encryptionKey: p.encryptionKey || void 0,
        clientInfo: "ioBroker.junghome-bt-mesh",
        reconnect: false
      }),
      {
        // the adapter refuses timers while it shuts down; the short, bounded timeouts of the
        // GATT disconnect then use a plain timer so the shutdown never waits forever
        setTimeout: (cb, ms) => this.unloading ? { shutdownTimer: setTimeout(cb, Math.min(ms, 3e3)) } : this.setTimeout(cb, ms),
        clearTimeout: (h) => {
          if (h && typeof h === "object" && "shutdownTimer" in h) {
            clearTimeout(h.shutdownTimer);
          } else {
            this.clearTimeout(h);
          }
        },
        now: () => Date.now()
      },
      this.log
    );
    this.link.on("ready", (host, _mac, rssi) => void this.onLinkReady(host, rssi));
    this.link.on("down", () => void this.onLinkDown());
    this.link.on("pdu", (type, pdu) => this.onPdu(type, pdu));
    this.log.info(`Found ${exp.thermostats.length} thermostat(s), connecting to the mesh`);
    this.link.start();
  }
  // ---------- objects ----------
  async createInfoObjects() {
    await this.extendObject("info", { type: "channel", common: { name: "Information" }, native: {} });
    const defs = [
      [
        "connection",
        {
          name: "Connected to the mesh",
          type: "boolean",
          role: "indicator.connected",
          read: true,
          write: false,
          def: false
        }
      ],
      [
        "proxy",
        { name: "ESPHome proxy in use", type: "string", role: "text", read: true, write: false, def: "" }
      ],
      [
        "rssi",
        {
          name: "Signal of the mesh node at the proxy",
          type: "number",
          role: "value",
          unit: "dBm",
          read: true,
          write: false
        }
      ],
      ["ivIndex", { name: "Mesh IV index", type: "number", role: "value", read: true, write: false, def: 0 }],
      [
        "seqReserve",
        {
          name: "Reserved sequence numbers (internal)",
          type: "number",
          role: "value",
          read: true,
          write: false,
          def: 0
        }
      ]
    ];
    for (const [id, common] of defs) {
      await this.extendObject(`info.${id}`, { type: "state", common, native: {} });
    }
  }
  async createRoom(t) {
    const id = `thermostats.${t.address.toString(16).toUpperCase().padStart(4, "0")}`;
    await this.extendObject("thermostats", { type: "folder", common: { name: "Thermostats" }, native: {} });
    await this.extendObject(id, { type: "channel", common: { name: t.name }, native: { address: t.address } });
    const states = [
      [
        "temperature",
        {
          name: "Room temperature (lead sensor or thermostat)",
          type: "number",
          role: "value.temperature",
          unit: "\xB0C",
          read: true,
          write: false
        }
      ],
      [
        "thermostatTemperature",
        {
          name: "Temperature measured by the thermostat",
          type: "number",
          role: "value.temperature",
          unit: "\xB0C",
          read: true,
          write: false
        }
      ],
      [
        "setpoint",
        {
          name: "Setpoint",
          type: "number",
          role: "level.temperature",
          unit: "\xB0C",
          min: 5,
          max: 30,
          step: 0.5,
          read: true,
          write: true
        }
      ],
      [
        "heating",
        { name: "Heating output active", type: "boolean", role: "indicator.working", read: true, write: false }
      ],
      ["mode", { name: "Operating mode (JUNG)", type: "number", role: "value", read: true, write: false }],
      ["boost", { name: "Boost", type: "boolean", role: "switch.boost", read: true, write: true, def: false }],
      [
        "vacation",
        {
          name: "In the vacation setback (true = rejoin, false = leave)",
          type: "boolean",
          role: "switch",
          read: true,
          write: true,
          def: false
        }
      ],
      [
        "boostUntil",
        { name: "Boost ends at", type: "number", role: "value.time", read: true, write: false, def: 0 }
      ],
      [
        "boostState",
        { name: "Boost data (internal)", type: "string", role: "json", read: true, write: false, def: "" }
      ],
      [
        "leadSensor",
        {
          name: "Lead sensor (object ID of a temperature state)",
          type: "string",
          role: "text",
          read: true,
          write: true,
          def: ""
        }
      ],
      [
        "color",
        {
          name: "Colour for the floor plan",
          type: "string",
          role: "level.color.rgb",
          read: true,
          write: false,
          def: ""
        }
      ],
      [
        "lastSeen",
        {
          name: "Last message from the thermostat",
          type: "number",
          role: "value.time",
          read: true,
          write: false,
          def: 0
        }
      ]
    ];
    for (const [sid, common] of states) {
      await this.extendObject(`${id}.${sid}`, { type: "state", common, native: {} });
    }
    const lead = await this.getStateAsync(`${id}.leadSensor`);
    const boostRaw = await this.getStateAsync(`${id}.boostState`);
    const setpoint = await this.getStateAsync(`${id}.setpoint`);
    const room = {
      info: t,
      id,
      setpoint: typeof (setpoint == null ? void 0 : setpoint.val) === "number" ? setpoint.val : null,
      deviceTemperature: null,
      leadSensor: typeof (lead == null ? void 0 : lead.val) === "string" ? lead.val : "",
      leadTemperature: null,
      boost: (0, import_boost.parseBoost)(boostRaw == null ? void 0 : boostRaw.val),
      boostTimer: void 0,
      pendingSetpoint: null
    };
    this.rooms.set(t.address, room);
    if (room.leadSensor) {
      await this.attachLeadSensor(room, room.leadSensor);
    }
    if (room.boost) {
      this.armBoostTimer(room);
    }
  }
  async createVacationObjects() {
    await this.extendObject("vacation", { type: "channel", common: { name: "Vacation setback" }, native: {} });
    const defs = [
      [
        "active",
        {
          name: "Vacation setback active",
          type: "boolean",
          role: "switch",
          read: true,
          write: true,
          def: false
        }
      ],
      [
        "returnAt",
        {
          name: "Return (ms, ISO date or DD.MM.YYYY; 0 = until switched off)",
          type: "number",
          role: "date",
          read: true,
          write: true,
          def: 0
        }
      ],
      [
        "preheatFrom",
        {
          name: "Previous setpoints come back at",
          type: "number",
          role: "value.time",
          read: true,
          write: false,
          def: 0
        }
      ],
      ["rooms", { name: "Lowered thermostats", type: "number", role: "value", read: true, write: false, def: 0 }],
      [
        "state",
        { name: "Vacation data (internal)", type: "string", role: "json", read: true, write: false, def: "" }
      ]
    ];
    for (const [sid, common] of defs) {
      await this.extendObject(`vacation.${sid}`, { type: "state", common, native: {} });
    }
    const raw = await this.getStateAsync("vacation.state");
    this.vacation = (0, import_vacation.parseVacation)(raw == null ? void 0 : raw.val);
    if (this.vacation) {
      const known = new Set([...this.rooms.values()].map((r) => r.id));
      for (const id of Object.keys(this.vacation.rooms)) {
        if (!known.has(id)) {
          delete this.vacation.rooms[id];
        }
      }
      await this.saveVacation();
      this.armVacationTimer();
    } else {
      await this.setState("vacation.active", { val: false, ack: true });
      await this.setState("vacation.preheatFrom", { val: 0, ack: true });
      await this.setState("vacation.rooms", { val: 0, ack: true });
    }
  }
  /** Removes channels of thermostats that are no longer in the export */
  async cleanupRooms() {
    const objs = await this.getObjectViewAsync("system", "channel", {
      startkey: `${this.namespace}.thermostats.`,
      endkey: `${this.namespace}.thermostats.\u9999`
    });
    const known = new Set([...this.rooms.values()].map((r) => `${this.namespace}.${r.id}`));
    for (const row of objs.rows) {
      if (!known.has(row.id)) {
        this.log.info(`Removing ${row.id}: the thermostat is no longer in the export`);
        await this.delObjectAsync(row.id, { recursive: true });
      }
    }
  }
  // ---------- mesh ----------
  async onLinkReady(host, rssi) {
    try {
      await this.link.send(import_mesh_codec.PROXY_TYPE_CONFIG, this.codec.encodeFilterAcceptAll());
      await this.setState("info.proxy", { val: host, ack: true });
      await this.setState("info.rssi", { val: rssi, ack: true });
      await this.setState("info.connection", { val: true, ack: true });
      for (const room of this.rooms.values()) {
        if (room.boost && (0, import_boost.boostRemaining)(room.boost, Date.now()) === 0) {
          await this.endBoost(room, "time is up");
        }
      }
      if (this.vacation && (0, import_vacation.vacationDue)(this.vacation, Date.now())) {
        await this.endVacation("pre-heating before the return");
      }
      await this.pollAll();
    } catch (e) {
      this.log.warn(`Mesh start-up failed: ${e.message}`);
    }
  }
  async onLinkDown() {
    if (this.pollTimer) {
      this.clearTimeout(this.pollTimer);
      this.pollTimer = void 0;
    }
    if (!this.unloading) {
      await this.setState("info.connection", { val: false, ack: true });
    }
  }
  onPdu(type, pdu) {
    let events;
    try {
      events = this.codec.handle(type, pdu, Date.now());
    } catch (e) {
      this.log.debug(`Mesh PDU ignored: ${e.message}`);
      return;
    }
    for (const ev of events) {
      if (ev.kind === "beacon") {
        void this.setState("info.ivIndex", { val: this.codec.ivIndex, ack: true });
      } else if (ev.kind === "filterStatus") {
        this.log.debug(`Proxy filter: ${ev.acceptList ? "accept list" : "reject list (receive all)"}`);
      } else {
        for (const u of (0, import_thermostat.interpret)(
          ev.message,
          [...this.rooms.values()].map((r) => r.info)
        )) {
          void this.applyUpdate(u);
        }
      }
    }
  }
  async applyUpdate(u) {
    var _a, _b;
    const room = this.rooms.get(u.address);
    if (!room) {
      return;
    }
    try {
      await this.setState(`${room.id}.lastSeen`, { val: Date.now(), ack: true });
      switch (u.field) {
        case "setpoint": {
          room.setpoint = u.value;
          const pending = room.pendingSetpoint;
          if (pending && Math.abs(pending.celsius - u.value) < 0.01) {
            pending.resolve(true);
            room.pendingSetpoint = null;
          } else if (!room.pendingSetpoint) {
            if (this.vacation && (0, import_vacation.vacationAfterReport)(this.vacation, room.id, u.value, (_b = (_a = room.boost) == null ? void 0 : _a.target) != null ? _b : null) === "manual") {
              await this.leaveVacation(room, u.value, true);
            }
            if (room.boost && (0, import_boost.boostAfterReport)(room.boost, u.value) === "cancel") {
              this.log.info(
                `${room.info.name}: setpoint changed during the boost, boost ends without restore`
              );
              await this.clearBoost(room);
            }
          }
          await this.setState(`${room.id}.setpoint`, { val: u.value, ack: true });
          break;
        }
        case "heating":
          await this.setState(`${room.id}.heating`, { val: u.value, ack: true });
          break;
        case "mode":
          await this.setState(`${room.id}.mode`, { val: u.value, ack: true });
          break;
        case "temperature":
          room.deviceTemperature = u.value;
          await this.setState(`${room.id}.thermostatTemperature`, { val: u.value, ack: true });
          await this.publishTemperature(room);
          break;
      }
    } catch (e) {
      this.log.warn(`Cannot store a value of ${room.id}: ${e.message}`);
    }
  }
  async send(dst, opcode, params) {
    var _a;
    if (!((_a = this.link) == null ? void 0 : _a.ready) || !this.codec) {
      throw new Error("not connected to the mesh");
    }
    await this.link.send(import_mesh_codec.PROXY_TYPE_NETWORK, this.codec.encodeAccess(dst, opcode, params));
  }
  async pollAll() {
    var _a;
    if (this.pollTimer) {
      this.clearTimeout(this.pollTimer);
      this.pollTimer = void 0;
    }
    for (const room of this.rooms.values()) {
      try {
        await this.send(room.info.levelAddress, import_thermostat.OP_GENERIC_LEVEL_GET);
        await this.delay(MESSAGE_GAP_MS);
        await this.send(room.info.onOffAddress, import_thermostat.OP_GENERIC_ONOFF_GET);
        await this.delay(MESSAGE_GAP_MS);
        await this.send(room.info.sensorAddress, import_thermostat.OP_SENSOR_GET, (0, import_thermostat.sensorGetParams)());
        await this.delay(MESSAGE_GAP_MS);
      } catch (e) {
        this.log.debug(`Poll of ${room.id} failed: ${e.message}`);
      }
    }
    if (((_a = this.link) == null ? void 0 : _a.ready) && this.cfg) {
      this.pollTimer = this.setTimeout(() => void this.pollAll(), this.cfg.pollMs);
    }
  }
  /**
   * Writes a setpoint and waits for the status of the thermostat. One retry.
   *
   * @param room Thermostat
   * @param celsius Setpoint on the device grid
   */
  async writeSetpoint(room, celsius) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const confirmed = new Promise((resolve) => {
        var _a;
        (_a = room.pendingSetpoint) == null ? void 0 : _a.resolve(false);
        room.pendingSetpoint = { celsius, resolve };
      });
      const timer = this.setTimeout(() => {
        var _a;
        return (_a = room.pendingSetpoint) == null ? void 0 : _a.resolve(false);
      }, CONFIRM_TIMEOUT_MS);
      this.tid = this.tid + 1 & 255;
      try {
        await this.send(room.info.levelAddress, import_thermostat.OP_GENERIC_LEVEL_SET, (0, import_thermostat.levelSetParams)(celsius, this.tid));
      } catch (e) {
        this.clearTimeout(timer);
        room.pendingSetpoint = null;
        this.log.warn(`${room.info.name}: setpoint not sent: ${e.message}`);
        return false;
      }
      const ok = await confirmed;
      this.clearTimeout(timer);
      room.pendingSetpoint = null;
      if (ok) {
        return true;
      }
    }
    this.log.warn(`${room.info.name}: the thermostat did not confirm the setpoint ${celsius} \xB0C`);
    return false;
  }
  // ---------- lead sensor ----------
  async attachLeadSensor(room, id) {
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
    if (!obj || obj.type !== "state") {
      this.log.warn(`${room.info.name}: lead sensor ${id} does not exist, using the thermostat`);
      room.leadSensor = "";
      await this.publishTemperature(room);
      return false;
    }
    await this.subscribeForeignStatesAsync(id);
    const st = await this.getForeignStateAsync(id);
    room.leadTemperature = typeof (st == null ? void 0 : st.val) === "number" && Number.isFinite(st.val) ? st.val : null;
    await this.publishTemperature(room);
    return true;
  }
  leadSensorUsedElsewhere(room, id) {
    return [...this.rooms.values()].some((r) => r !== room && r.leadSensor === id);
  }
  async publishTemperature(room) {
    const t = room.leadSensor && room.leadTemperature !== null ? room.leadTemperature : room.deviceTemperature;
    if (t === null) {
      return;
    }
    await this.setState(`${room.id}.temperature`, { val: Math.round(t * 10) / 10, ack: true });
    await this.setState(`${room.id}.color`, { val: (0, import_color.temperatureColor)(t), ack: true });
  }
  // ---------- boost ----------
  armBoostTimer(room) {
    if (room.boostTimer) {
      this.clearTimeout(room.boostTimer);
    }
    if (!room.boost) {
      return;
    }
    const ms = Math.min((0, import_boost.boostRemaining)(room.boost, Date.now()), 2 ** 31 - 1);
    room.boostTimer = this.setTimeout(() => {
      room.boostTimer = void 0;
      if (room.boost && (0, import_boost.boostRemaining)(room.boost, Date.now()) > 0) {
        this.armBoostTimer(room);
        return;
      }
      void this.endBoost(room, "time is up");
    }, ms);
  }
  async beginBoost(room) {
    if (room.boost) {
      await this.setState(`${room.id}.boost`, { val: true, ack: true });
      return;
    }
    const cfg = this.cfg;
    const boost = (0, import_boost.startBoost)(Date.now(), room.setpoint, cfg.boostMinutes, cfg.boostSetpoint);
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
    this.log.info(`${room.info.name}: boost to ${boost.target} \xB0C for ${cfg.boostMinutes} min`);
  }
  async endBoost(room, why) {
    var _a;
    const boost = room.boost;
    if (!boost) {
      return;
    }
    if (!((_a = this.link) == null ? void 0 : _a.ready)) {
      this.log.info(`${room.info.name}: boost ends (${why}), setpoint is restored after reconnect`);
      return;
    }
    const ok = await this.writeSetpoint(room, boost.previous);
    if (!ok) {
      this.log.warn(
        `${room.info.name}: previous setpoint ${boost.previous} \xB0C could not be restored, retry in 1 min`
      );
      room.boostTimer = this.setTimeout(() => void this.endBoost(room, why), 6e4);
      return;
    }
    this.log.info(`${room.info.name}: boost ended (${why}), back to ${boost.previous} \xB0C`);
    await this.clearBoost(room);
  }
  async clearBoost(room) {
    if (room.boostTimer) {
      this.clearTimeout(room.boostTimer);
      room.boostTimer = void 0;
    }
    room.boost = null;
    await this.setState(`${room.id}.boostState`, { val: "", ack: true });
    await this.setState(`${room.id}.boost`, { val: false, ack: true });
    await this.setState(`${room.id}.boostUntil`, { val: 0, ack: true });
  }
  // ---------- vacation ----------
  t(de, en) {
    return this.german ? de : en;
  }
  async saveVacation() {
    const v = this.vacation;
    await this.setState("vacation.state", { val: v ? JSON.stringify(v) : "", ack: true });
    await this.setState("vacation.active", { val: !!v, ack: true });
    if (v) {
      await this.setState("vacation.returnAt", { val: v.returnAt, ack: true });
    }
    await this.setState("vacation.preheatFrom", { val: v ? (0, import_vacation.preheatFrom)(v) : 0, ack: true });
    await this.setState("vacation.rooms", { val: v ? Object.keys(v.rooms).length : 0, ack: true });
    for (const room of this.rooms.values()) {
      await this.setState(`${room.id}.vacation`, { val: !!v && room.id in v.rooms, ack: true });
    }
  }
  armVacationTimer() {
    if (this.vacationTimer) {
      this.clearTimeout(this.vacationTimer);
      this.vacationTimer = void 0;
    }
    const v = this.vacation;
    if (!v || v.returnAt === 0 || this.unloading) {
      return;
    }
    const ms = Math.min(Math.max(0, (0, import_vacation.preheatFrom)(v) - Date.now()), 2 ** 31 - 1);
    this.vacationTimer = this.setTimeout(() => {
      this.vacationTimer = void 0;
      if (this.vacation && !(0, import_vacation.vacationDue)(this.vacation, Date.now())) {
        this.armVacationTimer();
        return;
      }
      void this.endVacation("pre-heating before the return");
    }, ms);
  }
  /**
   * Runs one vacation command at a time.
   *
   * @param job Command
   */
  async exclusive(job) {
    if (this.vacationBusy) {
      this.log.warn("Vacation setback: still busy with the last command, please try again");
      return void 0;
    }
    this.vacationBusy = true;
    try {
      return await job();
    } finally {
      this.vacationBusy = false;
    }
  }
  async onVacationCommand(id, value) {
    const done = await this.exclusive(async () => {
      var _a;
      if (id === "vacation.returnAt") {
        await this.onReturnAtCommand(value);
      } else if (value === true || value === "true" || value === 1) {
        const ret = await this.getStateAsync("vacation.returnAt");
        const parsed = (0, import_vacation.parseReturnAt)((_a = ret == null ? void 0 : ret.val) != null ? _a : 0, Date.now());
        if (!parsed.ok) {
          this.log.warn(`Vacation setback not started: ${parsed.error}`);
          await this.setState("vacation.active", { val: false, ack: true });
        } else {
          await this.beginVacation(parsed.at);
        }
      } else {
        await this.endVacation("switched off");
      }
      return true;
    });
    if (!done) {
      await this.saveVacation();
    }
  }
  async onReturnAtCommand(value) {
    const r = (0, import_vacation.parseReturnAt)(value, Date.now());
    if (!r.ok) {
      this.log.warn(`Vacation setback: ${r.error}`);
      const old = await this.getStateAsync("vacation.returnAt");
      await this.setState("vacation.returnAt", {
        val: this.vacation ? this.vacation.returnAt : typeof (old == null ? void 0 : old.val) === "number" ? old.val : 0,
        ack: true
      });
      return r.error;
    }
    if (!this.vacation) {
      await this.setState("vacation.returnAt", { val: r.at, ack: true });
      return null;
    }
    this.vacation.returnAt = r.at;
    this.log.info(`Vacation setback: return set to ${r.at ? new Date(r.at).toISOString() : "open end"}`);
    await this.saveVacation();
    if ((0, import_vacation.vacationDue)(this.vacation, Date.now())) {
      await this.endVacation("pre-heating before the return");
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
  async beginVacation(returnAt) {
    var _a;
    if (this.vacation) {
      await this.saveVacation();
      return null;
    }
    const cfg = this.cfg;
    const refuse = async (why, de) => {
      this.log.warn(`Vacation setback not started: ${why}`);
      await this.setState("vacation.active", { val: false, ack: true });
      return this.t(de, why);
    };
    if (!((_a = this.link) == null ? void 0 : _a.ready)) {
      return refuse("not connected to the mesh", "keine Verbindung zu den Thermostaten");
    }
    const draft = { returnAt, preheatHours: cfg.vacationPreheatHours };
    if ((0, import_vacation.vacationDue)(draft, Date.now())) {
      return refuse(
        `the return is less than ${cfg.vacationPreheatHours} h away`,
        `die R\xFCckkehr ist weniger als ${cfg.vacationPreheatHours} h entfernt`
      );
    }
    await this.setState("vacation.returnAt", { val: returnAt, ack: true });
    const rooms = [...this.rooms.values()];
    const plan = (0, import_vacation.planSetback)(
      rooms.map((r) => ({ id: r.id, setpoint: r.boost ? r.boost.previous : r.setpoint })),
      cfg.vacationSetpoint
    );
    for (const id of plan.unknown) {
      this.log.warn(`Vacation setback: ${this.nameOf(id)} skipped, its setpoint is not known yet`);
    }
    for (const id of plan.alreadyLow) {
      this.log.info(`Vacation setback: ${this.nameOf(id)} is already at or below ${cfg.vacationSetpoint} \xB0C`);
    }
    const vacation = {
      ...draft,
      target: cfg.vacationSetpoint,
      rooms: { ...plan.lower },
      left: {}
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
      if (!await this.writeSetpoint(room, cfg.vacationSetpoint)) {
        failed++;
        delete vacation.rooms[room.id];
      }
    }
    const lowered = Object.keys(vacation.rooms).length;
    if (failed && !lowered) {
      this.vacation = null;
      await this.saveVacation();
      return refuse("no thermostat accepted the setpoint", "kein Thermostat hat den Sollwert angenommen");
    }
    await this.saveVacation();
    this.armVacationTimer();
    const until = vacation.returnAt ? `, previous setpoints come back at ${new Date((0, import_vacation.preheatFrom)(vacation)).toISOString()}` : ", until switched off";
    this.log.info(
      `Vacation setback on: ${lowered} thermostat(s) at ${cfg.vacationSetpoint} \xB0C${failed ? `, ${failed} failed` : ""}${until}`
    );
    return null;
  }
  async endVacation(why) {
    var _a;
    const v = this.vacation;
    if (!v) {
      await this.saveVacation();
      return;
    }
    if (this.vacationTimer) {
      this.clearTimeout(this.vacationTimer);
      this.vacationTimer = void 0;
    }
    if (!((_a = this.link) == null ? void 0 : _a.ready)) {
      this.log.warn(`Vacation setback ends (${why}) as soon as the mesh is connected again`);
      if (why.startsWith("switched off")) {
        v.returnAt = Date.now();
        v.preheatHours = 0;
      }
      await this.saveVacation();
      return;
    }
    for (const [id, previous] of Object.entries(v.rooms)) {
      const room = [...this.rooms.values()].find((r) => r.id === id);
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
        this.vacationTimer = this.setTimeout(() => void this.endVacation(why), 6e4);
      }
      return;
    }
    this.vacation = null;
    await this.saveVacation();
    await this.setState("vacation.returnAt", { val: 0, ack: true });
    this.log.info(`Vacation setback ended (${why})`);
  }
  /**
   * A lowered room was changed by hand: the change counts as intended, the room leaves the setback.
   *
   * @param room Thermostat
   * @param celsius New setpoint
   * @param atDevice Changed at the thermostat (true) or through ioBroker (false)
   */
  async leaveVacation(room, celsius, atDevice) {
    if (!this.vacation || !(0, import_vacation.leaveSetback)(this.vacation, room.id)) {
      return;
    }
    await this.saveVacation();
    this.log.info(
      `${room.info.name}: setpoint ${celsius} \xB0C set by hand during the vacation, the room leaves the setback`
    );
    void this.notify((0, import_vacation.manualChangeText)(this.german, room.info.name, celsius, atDevice), {
      label: (0, import_vacation.rejoinButton)(this.german),
      data: `${import_vacation.REJOIN_PREFIX}${room.id.slice(-4)}`
    });
  }
  /**
   * Puts a room back into the running setback. Returns the answer for Telegram.
   *
   * @param room Thermostat
   */
  async rejoinVacation(room) {
    var _a;
    const v = this.vacation;
    const name = room.info.name;
    if (!v) {
      return this.t("\u{1F3E0} Der Urlaub ist schon vorbei.", "\u{1F3E0} The vacation is already over.");
    }
    if (room.id in v.rooms) {
      return this.t(
        `${name} ist bereits in der Urlaubsabsenkung.`,
        `${name} is already in the vacation setback.`
      );
    }
    const previous = (0, import_vacation.rejoinPrevious)(v, room.id, room.boost ? room.boost.previous : room.setpoint);
    if (previous === null) {
      return this.t(
        `${name}: kein Sollwert \xFCber ${v.target} \xB0C bekannt, nichts abzusenken.`,
        `${name}: no setpoint above ${v.target} \xB0C known, nothing to lower.`
      );
    }
    if (!((_a = this.link) == null ? void 0 : _a.ready)) {
      return this.t(
        `\u26A0\uFE0F ${name}: keine Verbindung zum Thermostat, bitte sp\xE4ter noch einmal.`,
        `\u26A0\uFE0F ${name}: no connection to the thermostat, please try again later.`
      );
    }
    v.rooms[room.id] = previous;
    delete v.left[room.id];
    await this.saveVacation();
    if (room.boost) {
      await this.clearBoost(room);
    }
    if (!await this.writeSetpoint(room, v.target)) {
      if (this.vacation === v) {
        delete v.rooms[room.id];
        v.left[room.id] = previous;
        await this.saveVacation();
      }
      return this.t(
        `\u26A0\uFE0F ${name}: Das Thermostat hat ${v.target} \xB0C nicht best\xE4tigt.`,
        `\u26A0\uFE0F ${name}: the thermostat did not confirm ${v.target} \xB0C.`
      );
    }
    this.log.info(`${name}: back in the vacation setback, ${previous} \xB0C comes back at the end`);
    return (0, import_vacation.rejoinText)(this.german, name, v.target, previous);
  }
  /**
   * Takes a room out of the setback through its vacation state and restores its previous setpoint.
   *
   * @param room Thermostat
   */
  async leaveByCommand(room) {
    const v = this.vacation;
    if (!v || !(room.id in v.rooms)) {
      await this.setState(`${room.id}.vacation`, { val: false, ack: true });
      return;
    }
    const previous = v.rooms[room.id];
    if (!await this.writeSetpoint(room, previous)) {
      await this.saveVacation();
      return;
    }
    (0, import_vacation.leaveSetback)(v, room.id);
    await this.saveVacation();
    this.log.info(`${room.info.name}: taken out of the vacation setback, back to ${previous} \xB0C`);
  }
  nameOf(id) {
    var _a, _b;
    return (_b = (_a = [...this.rooms.values()].find((r) => r.id === id)) == null ? void 0 : _a.info.name) != null ? _b : id;
  }
  /**
   * Sends a text through the messenger instance (Telegram) to the configured receivers. Failures are only logged.
   *
   * @param text Message
   * @param button Optional inline button
   * @param button.label Label of the button
   * @param button.data Callback data
   */
  async notify(text, button) {
    const cfg = this.cfg;
    if (!(cfg == null ? void 0 : cfg.notifyInstance)) {
      return;
    }
    const users = cfg.notifyUsers.length ? cfg.notifyUsers : [""];
    for (const user of users) {
      try {
        await this.sendToAsync(cfg.notifyInstance, "send", (0, import_telegram.telegramPayload)(text, { user }, button), {
          timeout: NOTIFY_TIMEOUT_MS
        });
      } catch (e) {
        this.log.warn(`Message via ${cfg.notifyInstance} not sent: ${e.message}`);
      }
    }
  }
  /**
   * A text or button press arrived at the telegram instance. Only vacation commands of known users are handled.
   *
   * @param request Value of telegram.N.communicate.request
   */
  async onTelegramRequest(request) {
    var _a, _b, _c;
    const cmd = (0, import_vacation.parseVacationCommand)(request);
    const instance = (_a = this.cfg) == null ? void 0 : _a.notifyInstance;
    if (!cmd || !instance) {
      return;
    }
    const chatId = (_b = await this.getForeignStateAsync(`${instance}.communicate.requestChatId`)) == null ? void 0 : _b.val;
    const users = (0, import_telegram.knownUsers)((_c = await this.getForeignStateAsync(`${instance}.communicate.users`)) == null ? void 0 : _c.val);
    if (typeof chatId !== "number" && typeof chatId !== "string" || !users.has(String(chatId))) {
      this.log.warn(
        "Vacation setback: Telegram command from a chat the telegram instance does not know, ignored"
      );
      return;
    }
    const reply = async (text) => {
      try {
        await this.sendToAsync(instance, "send", (0, import_telegram.telegramPayload)(text, { chatId }), {
          timeout: NOTIFY_TIMEOUT_MS
        });
      } catch (e) {
        this.log.warn(`Answer via ${instance} not sent: ${e.message}`);
      }
    };
    if (cmd.kind === "rejoin") {
      void this.sendToAsync(
        instance,
        "send",
        { text: "\u21A9\uFE0F", chatId, answerCallbackQuery: { text: "\u21A9\uFE0F", showAlert: false } },
        { timeout: NOTIFY_TIMEOUT_MS }
      ).catch(() => void 0);
    }
    const answer = await this.exclusive(async () => {
      const status = () => (0, import_vacation.statusText)(this.vacation, this.german, (id) => this.nameOf(id));
      switch (cmd.kind) {
        case "status":
          return status();
        case "off":
          if (!this.vacation) {
            return status();
          }
          await this.endVacation("switched off via Telegram");
          return this.vacation ? this.t(
            "\u26A0\uFE0F Urlaubsabsenkung endet, sobald die Thermostate wieder erreichbar sind.",
            "\u26A0\uFE0F The vacation setback ends as soon as the thermostats are reachable again."
          ) : this.t(
            "\u{1F3E0} Urlaubsabsenkung beendet, die vorherigen Sollwerte sind zur\xFCck.",
            "\u{1F3E0} Vacation setback ended, the previous setpoints are back."
          );
        case "on": {
          const parsed = cmd.returnAt ? (0, import_vacation.parseReturnAt)(cmd.returnAt, Date.now()) : { ok: true, at: 0 };
          if (!parsed.ok) {
            return this.t(
              `\u26A0\uFE0F Datum nicht verstanden. Beispiele: \u201EUrlaub bis 24.12.\u201C, \u201EUrlaub bis 24.12. 18:00\u201C, \u201EUrlaub bis Sonntag 18 Uhr\u201C, \u201EUrlaub bis morgen\u201C, \u201EUrlaub\u201C (ohne Ende).`,
              `\u26A0\uFE0F Date not understood. Examples: "vacation until 24.12.", "vacation until 24.12. 18:00", "vacation until sunday 18:00", "vacation until tomorrow", "vacation" (no end).`
            );
          }
          if (this.vacation) {
            const error2 = await this.onReturnAtCommand(parsed.at);
            return error2 ? `\u26A0\uFE0F ${error2}` : status();
          }
          const error = await this.beginVacation(parsed.at);
          return error ? this.t(`\u26A0\uFE0F Nicht gestartet: ${error}`, `\u26A0\uFE0F Not started: ${error}`) : status();
        }
        case "rejoin": {
          const room = this.rooms.get(parseInt(cmd.address, 16));
          return room ? this.rejoinVacation(room) : this.t("Raum unbekannt.", "Unknown room.");
        }
      }
    });
    await reply(
      answer != null ? answer : this.t(
        "\u23F3 Ich bin noch mit dem letzten Befehl besch\xE4ftigt, bitte gleich noch einmal.",
        "\u23F3 Still busy with the last command, please try again in a moment."
      )
    );
  }
  // ---------- state changes ----------
  async onStateChange(id, state) {
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
      if (local === "vacation.active" || local === "vacation.returnAt") {
        await this.onVacationCommand(local, state.val);
        return;
      }
      const m = /^thermostats\.([0-9A-F]{4})\.(setpoint|boost|vacation|leadSensor)$/.exec(
        id.slice(this.namespace.length + 1)
      );
      const room = m ? this.rooms.get(parseInt(m[1], 16)) : void 0;
      if (!m || !room) {
        return;
      }
      if (m[2] === "setpoint") {
        await this.onSetpointCommand(room, state.val);
      } else if (m[2] === "vacation") {
        const on = state.val === true || state.val === "true" || state.val === 1;
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
      } else if (m[2] === "boost") {
        if (state.val === true || state.val === "true" || state.val === 1) {
          await this.beginBoost(room);
        } else {
          await this.endBoost(room, "switched off");
          if (!room.boost) {
            await this.setState(`${room.id}.boost`, { val: false, ack: true });
          }
        }
      } else {
        const target = typeof state.val === "string" ? state.val.trim() : "";
        await this.attachLeadSensor(room, target);
        await this.setState(`${room.id}.leadSensor`, { val: room.leadSensor, ack: true });
      }
    } catch (e) {
      this.log.warn(`Command ${id} failed: ${e.message}`);
    }
  }
  async onSetpointCommand(room, value) {
    const restore = async () => {
      if (room.setpoint !== null) {
        await this.setState(`${room.id}.setpoint`, { val: room.setpoint, ack: true });
      }
    };
    const v = (0, import_thermostat.validateSetpoint)(value);
    if (!v.ok) {
      this.log.warn(`${room.info.name}: ${v.error}`);
      await restore();
      return;
    }
    const celsius = (0, import_thermostat.roundSetpoint)(v.celsius);
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
  async onForeignState(id, state) {
    if (id === this.telegramRequestId) {
      await this.onTelegramRequest(state.val);
      return;
    }
    for (const room of this.rooms.values()) {
      if (room.leadSensor === id) {
        room.leadTemperature = typeof state.val === "number" && Number.isFinite(state.val) ? state.val : null;
        await this.publishTemperature(room);
      }
    }
  }
  async onUnload(callback) {
    var _a, _b;
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
        (_a = room.pendingSetpoint) == null ? void 0 : _a.resolve(false);
      }
      await ((_b = this.link) == null ? void 0 : _b.stop());
      await this.setState("info.connection", { val: false, ack: true });
    } catch {
    } finally {
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new JunghomeBtMesh(options);
} else {
  (() => new JunghomeBtMesh())();
}
//# sourceMappingURL=main.js.map
