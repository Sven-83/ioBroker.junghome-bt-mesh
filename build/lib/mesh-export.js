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
var mesh_export_exports = {};
__export(mesh_export_exports, {
  checkOwnAddress: () => checkOwnAddress,
  parseMeshExport: () => parseMeshExport
});
module.exports = __toCommonJS(mesh_export_exports);
const MODEL_GENERIC_ONOFF_SERVER = "1000";
const MODEL_GENERIC_LEVEL_SERVER = "1002";
const MODEL_SENSOR_SERVER = "1100";
function key16(value, what) {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{32}$/.test(value)) {
    throw new Error(`${what} is missing or not 16 bytes`);
  }
  return Buffer.from(value, "hex");
}
function address(value, what) {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{4}$/.test(value)) {
    throw new Error(`${what} is not a 4-digit hex address`);
  }
  return parseInt(value, 16);
}
function parseMeshExport(text) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i;
  let outer;
  try {
    outer = JSON.parse(text);
  } catch {
    throw new Error("the export is not valid JSON");
  }
  if (typeof outer.network !== "string") {
    throw new Error('the export has no "network" part');
  }
  let net;
  try {
    net = JSON.parse(Buffer.from(outer.network, "base64").toString("utf8"));
  } catch {
    throw new Error('the "network" part of the export cannot be decoded');
  }
  if (!Array.isArray(net.netKeys) || !Array.isArray(net.appKeys) || !Array.isArray(net.nodes)) {
    throw new Error("the export has no keys or nodes");
  }
  const netKey = key16((_a = net.netKeys[0]) == null ? void 0 : _a.key, "NetKey");
  const appKey = key16((_b = net.appKeys[0]) == null ? void 0 : _b.key, "AppKey");
  const ivIndex = Number((_e = (_d = (_c = net.networkExclusions) == null ? void 0 : _c[0]) == null ? void 0 : _d.ivIndex) != null ? _e : 0) >>> 0;
  const deviceKeys = /* @__PURE__ */ new Map();
  const nodeRanges = [];
  const devices = Array.isArray((_f = outer.meta) == null ? void 0 : _f.devices) ? outer.meta.devices : [];
  const thermostats = [];
  for (const node of net.nodes) {
    const base = address(node.unicastAddress, "node address");
    const elements = Array.isArray(node.elements) ? node.elements : [];
    nodeRanges.push([base, base + Math.max(1, elements.length) - 1]);
    if (typeof node.deviceKey === "string" && /^[0-9a-fA-F]{32}$/.test(node.deviceKey)) {
      deviceKeys.set(base, Buffer.from(node.deviceKey, "hex"));
    }
    const elementWith = (model) => elements.findIndex((e) => Array.isArray(e.models) && e.models.some((m) => m.modelId === model));
    const level = elementWith(MODEL_GENERIC_LEVEL_SERVER);
    const onOff = elementWith(MODEL_GENERIC_ONOFF_SERVER);
    const sensor = elementWith(MODEL_SENSOR_SERVER);
    if (level < 0 || onOff < 0 || sensor < 0) {
      continue;
    }
    const device = devices.find((d) => {
      var _a2, _b2;
      return ((_b2 = (_a2 = d.deviceId) == null ? void 0 : _a2.nodeId) == null ? void 0 : _b2.toUpperCase()) === String(node.UUID).toUpperCase();
    });
    const mac = (_g = device == null ? void 0 : device.macAddress) == null ? void 0 : _g.toUpperCase();
    if (!mac || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) {
      continue;
    }
    thermostats.push({
      address: base,
      name: ((device == null ? void 0 : device.name) || node.name || `Thermostat ${base.toString(16)}`).trim(),
      mac,
      levelAddress: base + level,
      onOffAddress: base + onOff,
      sensorAddress: base + sensor
    });
  }
  const provisionerRanges = [];
  for (const p of (_h = net.provisioners) != null ? _h : []) {
    for (const r of (_i = p.allocatedUnicastRange) != null ? _i : []) {
      provisionerRanges.push([
        address(r.lowAddress, "provisioner range"),
        address(r.highAddress, "provisioner range")
      ]);
    }
  }
  return { netKey, appKey, ivIndex, deviceKeys, nodeRanges, provisionerRanges, thermostats };
}
function checkOwnAddress(own, exp) {
  if (!Number.isInteger(own) || own < 1 || own > 32767) {
    return "the own address must be a unicast address between 0001 and 7FFF";
  }
  for (const [a, b] of exp.nodeRanges) {
    if (own >= a && own <= b) {
      return `the own address ${own.toString(16).padStart(4, "0")} belongs to a device in the mesh`;
    }
  }
  for (const [a, b] of exp.provisionerRanges) {
    if (own >= a && own <= b) {
      return `the own address ${own.toString(16).padStart(4, "0")} is inside the range of the JUNG HOME app`;
    }
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  checkOwnAddress,
  parseMeshExport
});
//# sourceMappingURL=mesh-export.js.map
