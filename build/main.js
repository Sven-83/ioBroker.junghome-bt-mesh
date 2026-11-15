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
const CONFIRM_TIMEOUT_MS = 4e3;
const MESSAGE_GAP_MS = 300;
class JunghomeBtMesh extends utils.Adapter {
  cfg = null;
  codec = null;
  link = null;
  seq = null;
  rooms = /* @__PURE__ */ new Map();
  pollTimer;
  tid = Math.floor(Math.random() * 256);
  unloading = false;
  constructor(options = {}) {
    super({ ...options, name: "junghome-bt-mesh" });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
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
    this.subscribeStates("thermostats.*");
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
        setTimeout: (cb, ms) => this.setTimeout(cb, ms),
        clearTimeout: (h) => this.clearTimeout(h),
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
          } else if (room.boost && !room.pendingSetpoint && (0, import_boost.boostAfterReport)(room.boost, u.value) === "cancel") {
            this.log.info(
              `${room.info.name}: setpoint changed during the boost, boost ends without restore`
            );
            await this.clearBoost(room);
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
      const m = /^thermostats\.([0-9A-F]{4})\.(setpoint|boost|leadSensor)$/.exec(
        id.slice(this.namespace.length + 1)
      );
      const room = m ? this.rooms.get(parseInt(m[1], 16)) : void 0;
      if (!m || !room) {
        return;
      }
      if (m[2] === "setpoint") {
        await this.onSetpointCommand(room, state.val);
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
    if (room.boost) {
      this.log.info(`${room.info.name}: manual setpoint during the boost, boost ends without restore`);
      await this.clearBoost(room);
    }
    const ok = await this.writeSetpoint(room, (0, import_thermostat.roundSetpoint)(v.celsius));
    if (!ok) {
      await restore();
    }
  }
  async onForeignState(id, state) {
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
