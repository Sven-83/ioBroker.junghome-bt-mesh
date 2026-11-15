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
var mesh_codec_exports = {};
__export(mesh_codec_exports, {
  MeshCodec: () => MeshCodec,
  PROXY_TYPE_BEACON: () => PROXY_TYPE_BEACON,
  PROXY_TYPE_CONFIG: () => PROXY_TYPE_CONFIG,
  PROXY_TYPE_NETWORK: () => PROXY_TYPE_NETWORK,
  decodeOpcode: () => decodeOpcode,
  encodeOpcode: () => encodeOpcode
});
module.exports = __toCommonJS(mesh_codec_exports);
var import_mesh_crypto = require("./mesh-crypto");
const PROXY_TYPE_NETWORK = 0;
const PROXY_TYPE_BEACON = 1;
const PROXY_TYPE_CONFIG = 2;
const u16 = (n) => Buffer.from([n >> 8 & 255, n & 255]);
const u24 = (n) => Buffer.from([n >> 16 & 255, n >> 8 & 255, n & 255]);
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const SEGMENT_TIMEOUT_MS = 1e4;
const MAX_SEQ = 16777215;
function encodeOpcode(opcode) {
  if (opcode <= 126) {
    return Buffer.from([opcode]);
  }
  if (opcode <= 65535) {
    return u16(opcode);
  }
  return u24(opcode);
}
function decodeOpcode(access) {
  if (access.length === 0 || access[0] === 127) {
    return null;
  }
  if ((access[0] & 128) === 0) {
    return { opcode: access[0], params: access.subarray(1) };
  }
  if ((access[0] & 192) === 128) {
    return access.length < 2 ? null : { opcode: access.readUInt16BE(0), params: access.subarray(2) };
  }
  return access.length < 3 ? null : { opcode: access.readUIntBE(0, 3), params: access.subarray(3) };
}
class MeshCodec {
  /** @param options Keys and settings */
  constructor(options) {
    this.options = options;
    var _a;
    this.keys = (0, import_mesh_crypto.k2)(options.netKey, Buffer.from([0]));
    this.aid = (0, import_mesh_crypto.k4)(options.appKey);
    this.ttl = (_a = options.ttl) != null ? _a : 5;
    this.ivIndexValue = options.ivIndex >>> 0;
  }
  keys;
  aid;
  ttl;
  ivIndexValue;
  ivUpdate = false;
  replay = /* @__PURE__ */ new Map();
  segments = /* @__PURE__ */ new Map();
  /** Current IV index of the network */
  get ivIndex() {
    return this.ivIndexValue;
  }
  /** IV index used for sending (one lower while an IV update is in progress) */
  get txIvIndex() {
    return this.ivUpdate && this.ivIndexValue > 0 ? this.ivIndexValue - 1 : this.ivIndexValue;
  }
  /**
   * Builds a network PDU carrying an unsegmented access message encrypted with the AppKey.
   *
   * @param dst Destination address
   * @param opcode Access opcode
   * @param params Opcode parameters
   */
  encodeAccess(dst, opcode, params = Buffer.alloc(0)) {
    const access = Buffer.concat([encodeOpcode(opcode), params]);
    if (access.length > 11) {
      throw new Error("access message too long for an unsegmented PDU");
    }
    const seq = this.takeSeq();
    const iv = this.txIvIndex;
    const appNonce = Buffer.concat([
      Buffer.from([1, 0]),
      u24(seq),
      u16(this.options.ownAddress),
      u16(dst),
      u32(iv)
    ]);
    const upper = (0, import_mesh_crypto.ccmEncrypt)(this.options.appKey, appNonce, access, 4);
    const lower = Buffer.concat([Buffer.from([64 | this.aid]), upper]);
    return this.encodeNetwork(0, this.ttl, dst, lower, seq, iv, false);
  }
  /**
   * Builds a proxy configuration message that switches the proxy filter to a reject list
   * (empty reject list = receive everything).
   */
  encodeFilterAcceptAll() {
    const seq = this.takeSeq();
    return this.encodeNetwork(1, 0, 0, Buffer.from([0, 1]), seq, this.txIvIndex, true);
  }
  /**
   * Handles one complete (reassembled) proxy PDU.
   *
   * @param type Proxy PDU message type
   * @param data PDU without the proxy header
   * @param now Current time in ms (segment timeout)
   */
  handle(type, data, now) {
    if (type === PROXY_TYPE_BEACON) {
      return this.handleBeacon(data);
    }
    if (type !== PROXY_TYPE_NETWORK && type !== PROXY_TYPE_CONFIG) {
      return [];
    }
    const net = this.decodeNetwork(data, type === PROXY_TYPE_CONFIG);
    if (!net) {
      return [];
    }
    if (type === PROXY_TYPE_CONFIG) {
      if (net.transport[0] === 3 && net.transport.length >= 4) {
        return [
          {
            kind: "filterStatus",
            acceptList: net.transport[1] === 0,
            count: net.transport.readUInt16BE(2)
          }
        ];
      }
      return [];
    }
    if (net.ctl) {
      return [];
    }
    if (!this.acceptReplay(net.src, net.seq, net.iv)) {
      return [];
    }
    const message = this.decodeLowerTransport(net, now);
    return message ? [{ kind: "access", message }] : [];
  }
  takeSeq() {
    const seq = this.options.nextSeq();
    if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) {
      throw new Error("sequence number exhausted");
    }
    return seq;
  }
  handleBeacon(data) {
    if (data.length < 22 || data[0] !== 1) {
      return [];
    }
    const ivIndex = data.readUInt32BE(10);
    const ivUpdate = (data[1] & 2) !== 0;
    if (!this.beaconAuthentic(data)) {
      return [];
    }
    if (ivIndex >= this.ivIndexValue && ivIndex - this.ivIndexValue <= 42) {
      if (ivIndex !== this.ivIndexValue) {
        this.replay.clear();
      }
      this.ivIndexValue = ivIndex;
      this.ivUpdate = ivUpdate;
    }
    return [{ kind: "beacon", ivIndex, ivUpdate }];
  }
  beaconAuthentic(data) {
    const salt = (0, import_mesh_crypto.s1)("nkbk");
    const t = (0, import_mesh_crypto.cmac)(salt, this.options.netKey);
    const beaconKey = (0, import_mesh_crypto.cmac)(t, Buffer.concat([Buffer.from("id128", "ascii"), Buffer.from([1])]));
    const auth = (0, import_mesh_crypto.cmac)(beaconKey, data.subarray(1, 14)).subarray(0, 8);
    return auth.equals(data.subarray(14, 22));
  }
  encodeNetwork(ctl, ttl, dst, transport, seq, iv, proxyNonce) {
    const ctlTtl = ctl << 7 | ttl & 127;
    const nonce = Buffer.concat([
      Buffer.from([proxyNonce ? 3 : 0, proxyNonce ? 0 : ctlTtl]),
      u24(seq),
      u16(this.options.ownAddress),
      Buffer.from([0, 0]),
      u32(iv)
    ]);
    const encrypted = (0, import_mesh_crypto.ccmEncrypt)(this.keys.encryptionKey, nonce, Buffer.concat([u16(dst), transport]), ctl ? 8 : 4);
    const pecb = (0, import_mesh_crypto.aesEcb)(this.keys.privacyKey, Buffer.concat([Buffer.alloc(5), u32(iv), encrypted.subarray(0, 7)]));
    const header = (0, import_mesh_crypto.xor)(
      Buffer.concat([Buffer.from([ctlTtl]), u24(seq), u16(this.options.ownAddress)]),
      pecb.subarray(0, 6)
    );
    return Buffer.concat([Buffer.from([(iv & 1) << 7 | this.keys.nid]), header, encrypted]);
  }
  decodeNetwork(pdu, proxyNonce) {
    if (pdu.length < 14 || (pdu[0] & 127) !== this.keys.nid) {
      return null;
    }
    const ivi = pdu[0] >> 7;
    const iv = (this.ivIndexValue & 1) === ivi ? this.ivIndexValue : this.ivIndexValue - 1;
    if (iv < 0) {
      return null;
    }
    const pecb = (0, import_mesh_crypto.aesEcb)(this.keys.privacyKey, Buffer.concat([Buffer.alloc(5), u32(iv), pdu.subarray(7, 14)]));
    const header = (0, import_mesh_crypto.xor)(pdu.subarray(1, 7), pecb.subarray(0, 6));
    const ctl = header[0] >> 7;
    const ttl = header[0] & 127;
    const seq = header.readUIntBE(1, 3);
    const src = header.readUInt16BE(4);
    const micLength = ctl ? 8 : 4;
    const nonce = Buffer.concat([
      Buffer.from([proxyNonce ? 3 : 0, proxyNonce ? 0 : header[0]]),
      u24(seq),
      u16(src),
      Buffer.from([0, 0]),
      u32(iv)
    ]);
    const plain = (0, import_mesh_crypto.ccmDecrypt)(this.keys.encryptionKey, nonce, pdu.subarray(7), micLength);
    if (!plain || plain.length < 3) {
      return null;
    }
    return { ctl, ttl, seq, src, dst: plain.readUInt16BE(0), iv, transport: plain.subarray(2) };
  }
  acceptReplay(src, seq, iv) {
    if (src === this.options.ownAddress) {
      return false;
    }
    const last = this.replay.get(src);
    if (last && (iv < last.iv || iv === last.iv && seq <= last.seq)) {
      return false;
    }
    this.replay.set(src, { iv, seq });
    return true;
  }
  decodeLowerTransport(net, now) {
    var _a;
    const t = net.transport;
    const segmented = t[0] >> 7;
    const akf = t[0] >> 6 & 1;
    const aid = t[0] & 63;
    let upper;
    let szmic = 0;
    let seqAuth = net.seq;
    if (!segmented) {
      upper = t.subarray(1);
    } else {
      if (t.length < 5) {
        return null;
      }
      szmic = t[1] >> 7;
      const seqZero = (t[1] & 127) << 6 | t[2] >> 2;
      const segO = (t[2] & 3) << 3 | t[3] >> 5;
      const segN = t[3] & 31;
      if (segO > segN) {
        return null;
      }
      seqAuth = net.seq & ~8191 | seqZero;
      if (seqAuth > net.seq) {
        seqAuth -= 8192;
      }
      this.dropStaleSegments(now);
      const id = `${net.src}:${seqZero}`;
      const entry = (_a = this.segments.get(id)) != null ? _a : { parts: [], segN, started: now };
      entry.parts[segO] = t.subarray(4);
      this.segments.set(id, entry);
      for (let i = 0; i <= entry.segN; i++) {
        if (!entry.parts[i]) {
          return null;
        }
      }
      this.segments.delete(id);
      upper = Buffer.concat(entry.parts);
    }
    let key;
    if (akf) {
      key = aid === this.aid ? this.options.appKey : void 0;
    } else {
      key = this.options.deviceKeys.get(net.src);
    }
    if (!key) {
      return null;
    }
    const nonce = Buffer.concat([
      Buffer.from([akf ? 1 : 2, szmic << 7]),
      u24(seqAuth),
      u16(net.src),
      u16(net.dst),
      u32(net.iv)
    ]);
    const access = (0, import_mesh_crypto.ccmDecrypt)(key, nonce, upper, szmic ? 8 : 4);
    if (!access) {
      return null;
    }
    const op = decodeOpcode(access);
    return op ? { src: net.src, dst: net.dst, opcode: op.opcode, params: op.params } : null;
  }
  dropStaleSegments(now) {
    for (const [id, entry] of this.segments) {
      if (now - entry.started > SEGMENT_TIMEOUT_MS) {
        this.segments.delete(id);
      }
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MeshCodec,
  PROXY_TYPE_BEACON,
  PROXY_TYPE_CONFIG,
  PROXY_TYPE_NETWORK,
  decodeOpcode,
  encodeOpcode
});
//# sourceMappingURL=mesh-codec.js.map
