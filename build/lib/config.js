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
function numberIn(value, min, max, fallback, label, warnings) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= min && n <= max) {
    return n;
  }
  warnings.push(`${label} must be between ${min} and ${max}, using ${fallback}`);
  return fallback;
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
function messenger(enabled, instance, warnings) {
  if (enabled === false) {
    return "";
  }
  const i = typeof instance === "string" ? instance.trim().replace(/^system\.adapter\./, "") : "";
  if (!i) {
    return "telegram.0";
  }
  if (/^[a-z0-9][a-z0-9_-]*\.\d{1,3}$/.test(i)) {
    return i;
  }
  warnings.push(`"${i}" is not an adapter instance like telegram.0, messages are off`);
  return "";
}
function receivers(value) {
  const list = typeof value === "string" ? value : "";
  return [
    ...new Set(
      list.split(",").map((u) => u.trim()).filter(Boolean)
    )
  ];
}
function checkConfig(native) {
  const errors = [];
  const warnings = [];
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
      pollMs: numberIn(native.pollMinutes, 1, 60, 5, "Poll interval (minutes)", warnings) * 6e4,
      boostMinutes: numberIn(native.boostMinutes, 1, 240, 60, "Boost duration (minutes)", warnings),
      boostSetpoint: numberIn(native.boostSetpoint, 5, 30, 30, "Boost setpoint (\xB0C)", warnings),
      vacationSetpoint: numberIn(native.vacationSetpoint, 5, 30, 17, "Vacation setpoint (\xB0C)", warnings),
      vacationPreheatHours: numberIn(
        native.vacationPreheatHours,
        0,
        96,
        24,
        "Pre-heating before the return (hours)",
        warnings
      ),
      notifyInstance: messenger(native.notifyEnabled, native.notifyInstance, warnings),
      notifyUsers: receivers(native.notifyUsers)
    },
    errors,
    warnings
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  checkConfig
});
//# sourceMappingURL=config.js.map
