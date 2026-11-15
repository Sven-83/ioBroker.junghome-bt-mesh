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
var config_exports = {};
__export(config_exports, {
  checkConfig: () => checkConfig
});
module.exports = __toCommonJS(config_exports);
const HOST = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/;
function intIn(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}
function proxy(host, key, label, errors) {
  const h = typeof host === "string" ? host.trim() : "";
  if (!h) {
    return null;
  }
  if (!HOST.test(h)) {
    errors.push(`${label}: "${h}" is not a valid host name or IP address`);
    return null;
  }
  const k = typeof key === "string" ? key.trim() : "";
  if (k && (!/^[A-Za-z0-9+/]{43}=$/.test(k) || Buffer.from(k, "base64").length !== 32)) {
    errors.push(
      `${label}: the API encryption key must be the 44-character base64 key from the ESPHome configuration`
    );
    return null;
  }
  return { host: h, port: 6053, encryptionKey: k };
}
function checkConfig(native) {
  const errors = [];
  const addrText = typeof native.ownAddress === "string" ? native.ownAddress.trim() : "";
  const ownAddress = /^[0-9a-fA-F]{4}$/.test(addrText) ? parseInt(addrText, 16) : NaN;
  if (Number.isNaN(ownAddress)) {
    errors.push("the own address must be 4 hex digits, e.g. 0D01");
  }
  const proxies = [
    proxy(native.proxy1Host, native.proxy1Key, "Proxy 1", errors),
    proxy(native.proxy2Host, native.proxy2Key, "Proxy 2", errors)
  ].filter((p) => p !== null);
  if (!proxies.length && !errors.some((e) => e.startsWith("Proxy"))) {
    errors.push("no ESPHome Bluetooth proxy is configured");
  }
  if (typeof native.meshExport !== "string" || native.meshExport.trim() === "") {
    errors.push("the JUNG HOME project export is missing");
  }
  return {
    config: {
      ownAddress,
      proxies,
      pollMs: intIn(native.pollMinutes, 1, 60, 5) * 6e4,
      boostMinutes: intIn(native.boostMinutes, 5, 240, 60),
      boostSetpoint: intIn(native.boostSetpoint, 5, 30, 30)
    },
    errors
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  checkConfig
});
//# sourceMappingURL=config.js.map
