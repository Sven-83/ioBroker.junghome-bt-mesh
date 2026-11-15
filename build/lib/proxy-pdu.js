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
var proxy_pdu_exports = {};
__export(proxy_pdu_exports, {
  ProxyReassembler: () => ProxyReassembler,
  segmentProxyPdu: () => segmentProxyPdu
});
module.exports = __toCommonJS(proxy_pdu_exports);
const SAR_COMPLETE = 0;
const SAR_FIRST = 1;
const SAR_CONTINUATION = 2;
const SAR_LAST = 3;
function segmentProxyPdu(type, pdu, mtu) {
  const chunk = Math.max(19, (mtu || 23) - 4);
  if (pdu.length <= chunk) {
    return [Buffer.concat([Buffer.from([SAR_COMPLETE << 6 | type]), pdu])];
  }
  const out = [];
  for (let i = 0; i < pdu.length; i += chunk) {
    const sar = i === 0 ? SAR_FIRST : i + chunk >= pdu.length ? SAR_LAST : SAR_CONTINUATION;
    out.push(Buffer.concat([Buffer.from([sar << 6 | type]), pdu.subarray(i, i + chunk)]));
  }
  return out;
}
class ProxyReassembler {
  buffer = null;
  type = -1;
  /**
   * Adds one notification and returns the complete PDU when it is finished.
   *
   * @param data One GATT notification
   */
  push(data) {
    if (data.length < 1) {
      return null;
    }
    const sar = data[0] >> 6;
    const type = data[0] & 63;
    const payload = data.subarray(1);
    switch (sar) {
      case SAR_COMPLETE:
        this.buffer = null;
        return { type, pdu: Buffer.from(payload) };
      case SAR_FIRST:
        this.buffer = Buffer.from(payload);
        this.type = type;
        return null;
      case SAR_CONTINUATION:
        if (!this.buffer || type !== this.type) {
          this.buffer = null;
          return null;
        }
        this.buffer = Buffer.concat([this.buffer, payload]);
        return null;
      default: {
        if (!this.buffer || type !== this.type) {
          this.buffer = null;
          return null;
        }
        const pdu = Buffer.concat([this.buffer, payload]);
        this.buffer = null;
        return { type, pdu };
      }
    }
  }
  /** Drops a half received PDU (e.g. after a reconnect) */
  reset() {
    this.buffer = null;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ProxyReassembler,
  segmentProxyPdu
});
//# sourceMappingURL=proxy-pdu.js.map
