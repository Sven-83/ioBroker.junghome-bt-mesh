"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var mesh_link_exports = {};
__export(mesh_link_exports, {
  MeshLink: () => MeshLink,
  backoffDelay: () => backoffDelay,
  uuid16: () => uuid16
});
module.exports = __toCommonJS(mesh_link_exports);
var import_node_events = require("node:events");
var import_proxy_pdu = require("./proxy-pdu");
const MESH_PROXY_SERVICE = 6184;
const MESH_PROXY_DATA_IN = 10973;
const MESH_PROXY_DATA_OUT = 10974;
const CCCD = 10498;
const API_TIMEOUT_MS = 15e3;
const SCAN_MS = 15e3;
const COLLECT_MS = 1500;
const GATT_TIMEOUT_MS = 2e4;
const WRITE_TIMEOUT_MS = 3e3;
const BACKOFF_START_MS = 5e3;
const BACKOFF_MAX_MS = 3e5;
function uuid16(o) {
  if (typeof o.shortUuid === "number" && o.shortUuid > 0) {
    return o.shortUuid;
  }
  if (typeof o.uuid === "string" && /^0000[0-9a-f]{4}-0000-1000-8000-00805f9b34fb$/i.test(o.uuid)) {
    return parseInt(o.uuid.slice(4, 8), 16);
  }
  const list = Array.isArray(o.uuidList) && o.uuidList.length ? o.uuidList : Array.isArray(o.uuid) ? o.uuid : null;
  if (list) {
    try {
      return Number(BigInt(String(list[0])) >> 32n & 0xffffn);
    } catch {
      return -1;
    }
  }
  return -1;
}
function backoffDelay(attempt) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.max(0, attempt - 1));
}
const macToNumber = (mac) => parseInt(mac.replace(/:/g, ""), 16);
class MeshLink extends import_node_events.EventEmitter {
  /**
   * @param proxies Proxies in order of preference
   * @param nodeMacs MACs of mesh proxy nodes (thermostats)
   * @param createConnection Factory for an ESPHome API connection
   * @param scheduler Adapter timers
   * @param log Adapter log
   */
  constructor(proxies, nodeMacs, createConnection, scheduler, log) {
    super();
    this.proxies = proxies;
    this.nodeMacs = nodeMacs;
    this.createConnection = createConnection;
    this.scheduler = scheduler;
    this.log = log;
  }
  conn = null;
  connectedMac = null;
  attemptMac = null;
  dataIn = -1;
  mtu = 23;
  attempt = 0;
  proxyIndex = 0;
  retryTimer = null;
  stopped = true;
  generation = 0;
  reassembler = new import_proxy_pdu.ProxyReassembler();
  writeChain = Promise.resolve();
  /** True when PDUs can be sent */
  get ready() {
    return this.connectedMac !== null && this.dataIn >= 0;
  }
  /** Starts connecting */
  start() {
    this.stopped = false;
    this.attempt = 0;
    this.proxyIndex = 0;
    this.scheduleConnect(0);
  }
  /** Closes everything; no reconnect afterwards */
  async stop() {
    this.stopped = true;
    if (this.retryTimer) {
      this.scheduler.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    await this.teardown("stopped", false);
  }
  /**
   * Sends a PDU, segmented to the MTU. Writes are serialised.
   *
   * @param type Proxy PDU type
   * @param pdu Network or proxy configuration PDU
   */
  send(type, pdu) {
    const run = async () => {
      if (!this.ready || !this.conn || this.connectedMac === null) {
        throw new Error("not connected to the mesh");
      }
      for (const part of (0, import_proxy_pdu.segmentProxyPdu)(type, pdu, this.mtu)) {
        await this.withTimeout(
          this.conn.writeBluetoothGATTCharacteristicService(
            this.connectedMac,
            this.dataIn,
            new Uint8Array(part),
            false
          ),
          WRITE_TIMEOUT_MS,
          "GATT write"
        );
      }
    };
    const result = this.writeChain.then(run, run);
    this.writeChain = result.catch(() => void 0);
    return result;
  }
  scheduleConnect(ms) {
    if (this.stopped) {
      return;
    }
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = null;
      void this.connectOnce();
    }, ms);
  }
  async connectOnce() {
    const gen = ++this.generation;
    const proxy = this.proxies[this.proxyIndex % this.proxies.length];
    try {
      await this.openApi(proxy, gen);
      const node = await this.findNode(gen);
      await this.openGatt(node.mac, node.addressType, gen);
      this.attempt = 0;
      const macText = node.mac.toString(16).toUpperCase().padStart(12, "0").replace(/(..)(?!$)/g, "$1:");
      this.log.info(`Connected to the mesh through ${proxy.host} (node ${macText}, RSSI ${node.rssi} dBm)`);
      this.emit("ready", proxy.host, macText, node.rssi);
    } catch (e) {
      if (gen !== this.generation || this.stopped) {
        return;
      }
      this.attempt++;
      const delay = backoffDelay(this.attempt);
      this.log.warn(
        `Mesh connection through ${proxy.host} failed: ${e.message}; next try in ${Math.round(delay / 1e3)} s`
      );
      await this.teardown(e.message, false);
      if (this.proxies.length > 1) {
        this.proxyIndex = (this.proxyIndex + 1) % this.proxies.length;
      }
      this.scheduleConnect(delay);
    }
  }
  openApi(proxy, gen) {
    return new Promise((resolve, reject) => {
      const conn = this.createConnection(proxy);
      this.conn = conn;
      const timer = this.scheduler.setTimeout(() => reject(new Error("ESPHome API timeout")), API_TIMEOUT_MS);
      conn.on("error", (e) => {
        var _a;
        this.log.debug(`ESPHome API ${proxy.host}: ${(_a = e == null ? void 0 : e.message) != null ? _a : String(e)}`);
      });
      conn.on("disconnected", () => {
        this.scheduler.clearTimeout(timer);
        reject(new Error("ESPHome API closed"));
        this.lost(gen, "ESPHome API connection closed");
      });
      conn.once("authorized", () => {
        this.scheduler.clearTimeout(timer);
        resolve();
      });
      conn.on("message.BluetoothDeviceConnectionResponse", (m) => {
        if (this.connectedMac !== null && Number(m.address) === this.connectedMac && !m.connected) {
          this.lost(gen, "thermostat disconnected");
        }
      });
      conn.on("message.BluetoothGATTNotifyDataResponse", (m) => {
        if (gen !== this.generation) {
          return;
        }
        const data = typeof m.data === "string" ? Buffer.from(m.data, "base64") : Buffer.from(m.data);
        const complete = this.reassembler.push(data);
        if (complete) {
          this.emit("pdu", complete.type, complete.pdu);
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
  findNode(gen) {
    const wanted = new Set(this.nodeMacs.map(macToNumber));
    const best = /* @__PURE__ */ new Map();
    return new Promise((resolve, reject) => {
      const conn = this.conn;
      if (!conn) {
        reject(new Error("no API connection"));
        return;
      }
      let done = false;
      let collectTimer = null;
      let overall = null;
      const finish = () => {
        if (done) {
          return;
        }
        done = true;
        this.scheduler.clearTimeout(overall);
        if (collectTimer) {
          this.scheduler.clearTimeout(collectTimer);
        }
        if (gen !== this.generation) {
          reject(new Error("superseded"));
          return;
        }
        const sorted = [...best.entries()].sort((a, b) => b[1].rssi - a[1].rssi);
        if (!sorted.length) {
          reject(new Error("no JUNG HOME thermostat in range of this proxy"));
          return;
        }
        resolve({ mac: sorted[0][0], addressType: sorted[0][1].addressType, rssi: sorted[0][1].rssi });
      };
      overall = this.scheduler.setTimeout(finish, SCAN_MS);
      conn.on(
        "message.BluetoothLERawAdvertisementsResponse",
        (m) => {
          var _a, _b;
          if (done) {
            return;
          }
          for (const a of (_a = m.advertisementsList) != null ? _a : []) {
            const mac = Number(a.address);
            if (wanted.has(mac)) {
              const prev = best.get(mac);
              if (!prev || a.rssi > prev.rssi) {
                best.set(mac, { addressType: (_b = a.addressType) != null ? _b : 0, rssi: a.rssi });
              }
            }
          }
          if (best.size && !collectTimer) {
            collectTimer = this.scheduler.setTimeout(finish, wanted.size > 1 ? COLLECT_MS : 0);
          }
        }
      );
      conn.subscribeBluetoothAdvertisementService();
    });
  }
  async openGatt(mac, addressType, gen) {
    var _a;
    const conn = this.conn;
    if (!conn) {
      throw new Error("no API connection");
    }
    this.attemptMac = mac;
    const res = await this.withTimeout(
      conn.connectBluetoothDeviceService(mac, addressType, false),
      GATT_TIMEOUT_MS,
      "GATT connect"
    );
    if (!res.connected) {
      throw new Error(`GATT connect refused (error ${res.error})`);
    }
    if (gen !== this.generation) {
      throw new Error("superseded");
    }
    this.connectedMac = mac;
    this.mtu = res.mtu || 23;
    const { servicesList } = await this.withTimeout(
      conn.listBluetoothGATTServicesService(mac),
      GATT_TIMEOUT_MS,
      "GATT services"
    );
    const svc = servicesList.find((s) => uuid16(s) === MESH_PROXY_SERVICE);
    if (!svc) {
      throw new Error("the node offers no Mesh Proxy service");
    }
    const chIn = svc.characteristicsList.find((c) => uuid16(c) === MESH_PROXY_DATA_IN);
    const chOut = svc.characteristicsList.find((c) => uuid16(c) === MESH_PROXY_DATA_OUT);
    if (!chIn || !chOut) {
      throw new Error("Mesh Proxy characteristics missing");
    }
    await this.withTimeout(
      conn.notifyBluetoothGATTCharacteristicService(mac, chOut.handle),
      GATT_TIMEOUT_MS,
      "GATT notify"
    );
    const cccd = ((_a = chOut.descriptorsList) != null ? _a : []).find((d) => uuid16(d) === CCCD);
    if (cccd) {
      await this.withTimeout(
        conn.writeBluetoothGATTDescriptorService(mac, cccd.handle, new Uint8Array([1, 0])),
        GATT_TIMEOUT_MS,
        "GATT descriptor"
      );
    }
    this.reassembler.reset();
    this.dataIn = chIn.handle;
  }
  lost(gen, reason) {
    if (gen !== this.generation || this.stopped || !this.ready) {
      return;
    }
    this.generation++;
    void this.teardown(reason, true).then(() => {
      this.attempt = 1;
      this.log.warn(`Mesh connection lost: ${reason}; reconnecting`);
      this.scheduleConnect(backoffDelay(1));
    });
  }
  async teardown(reason, emitDown) {
    var _a;
    const conn = this.conn;
    const mac = (_a = this.connectedMac) != null ? _a : this.attemptMac;
    this.conn = null;
    this.connectedMac = null;
    this.attemptMac = null;
    this.dataIn = -1;
    if (conn) {
      if (mac !== null) {
        await this.withTimeout(conn.disconnectBluetoothDeviceService(mac), 3e3, "GATT disconnect").catch(
          () => void 0
        );
      }
      try {
        conn.removeAllListeners();
        conn.on("error", () => void 0);
        conn.disconnect();
      } catch {
      }
    }
    if (emitDown) {
      this.emit("down", reason);
    }
  }
  withTimeout(p, ms, what) {
    return new Promise((resolve, reject) => {
      const timer = this.scheduler.setTimeout(() => reject(new Error(`${what} timeout`)), ms);
      p.then(
        (v) => {
          this.scheduler.clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          this.scheduler.clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      );
    });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MeshLink,
  backoffDelay,
  uuid16
});
//# sourceMappingURL=mesh-link.js.map
