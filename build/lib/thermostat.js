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
var thermostat_exports = {};
__export(thermostat_exports, {
  OP_GENERIC_LEVEL_GET: () => OP_GENERIC_LEVEL_GET,
  OP_GENERIC_LEVEL_SET: () => OP_GENERIC_LEVEL_SET,
  OP_GENERIC_LEVEL_STATUS: () => OP_GENERIC_LEVEL_STATUS,
  OP_GENERIC_ONOFF_GET: () => OP_GENERIC_ONOFF_GET,
  OP_GENERIC_ONOFF_STATUS: () => OP_GENERIC_ONOFF_STATUS,
  OP_JUNG_ADMIN_STATUS: () => OP_JUNG_ADMIN_STATUS,
  OP_SENSOR_GET: () => OP_SENSOR_GET,
  OP_SENSOR_STATUS: () => OP_SENSOR_STATUS,
  PROPERTY_JUNG_OPERATING_MODE: () => PROPERTY_JUNG_OPERATING_MODE,
  PROPERTY_TEMPERATURE_8: () => PROPERTY_TEMPERATURE_8,
  SETPOINT_MAX: () => SETPOINT_MAX,
  SETPOINT_MIN: () => SETPOINT_MIN,
  SETPOINT_STEP: () => SETPOINT_STEP,
  celsiusToLevel: () => celsiusToLevel,
  interpret: () => interpret,
  levelSetParams: () => levelSetParams,
  levelToCelsius: () => levelToCelsius,
  roundSetpoint: () => roundSetpoint,
  sensorGetParams: () => sensorGetParams,
  validateSetpoint: () => validateSetpoint
});
module.exports = __toCommonJS(thermostat_exports);
const OP_GENERIC_ONOFF_GET = 33281;
const OP_GENERIC_ONOFF_STATUS = 33284;
const OP_GENERIC_LEVEL_GET = 33285;
const OP_GENERIC_LEVEL_SET = 33286;
const OP_GENERIC_LEVEL_STATUS = 33288;
const OP_SENSOR_GET = 33329;
const OP_SENSOR_STATUS = 82;
const OP_JUNG_ADMIN_STATUS = 13707013;
const PROPERTY_TEMPERATURE_8 = 79;
const PROPERTY_JUNG_OPERATING_MODE = 4619;
const SETPOINT_MIN = 5;
const SETPOINT_MAX = 30;
const SETPOINT_STEP = 0.5;
function levelToCelsius(level) {
  const pct = Math.min(100, Math.max(0, Math.round((level + 32768) * 100 / 65535)));
  return roundSetpoint(SETPOINT_MIN + (SETPOINT_MAX - SETPOINT_MIN) * pct / 100);
}
function celsiusToLevel(celsius) {
  const pct = Math.round((celsius - SETPOINT_MIN) / (SETPOINT_MAX - SETPOINT_MIN) * 100);
  return Math.round(pct / 100 * 65535) - 32768;
}
function roundSetpoint(celsius) {
  return Math.round(celsius / SETPOINT_STEP) * SETPOINT_STEP;
}
function validateSetpoint(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return { ok: false, error: "the setpoint needs a number" };
  }
  if (n < SETPOINT_MIN || n > SETPOINT_MAX) {
    return { ok: false, error: `the setpoint must be between ${SETPOINT_MIN} and ${SETPOINT_MAX} \xB0C` };
  }
  return { ok: true, celsius: roundSetpoint(n) };
}
function levelSetParams(celsius, tid) {
  const p = Buffer.alloc(3);
  p.writeInt16LE(celsiusToLevel(celsius), 0);
  p[2] = tid & 255;
  return p;
}
function sensorGetParams() {
  const p = Buffer.alloc(2);
  p.writeUInt16LE(PROPERTY_TEMPERATURE_8, 0);
  return p;
}
function parseSensorStatus(params) {
  const out = /* @__PURE__ */ new Map();
  let i = 0;
  while (i < params.length) {
    let length;
    let property;
    if ((params[i] & 1) === 0) {
      if (i + 2 > params.length) {
        break;
      }
      const v = params.readUInt16LE(i);
      length = (v >> 1 & 15) + 1;
      property = v >> 5;
      i += 2;
    } else {
      if (i + 3 > params.length) {
        break;
      }
      length = (params[i] >> 1) + 1;
      property = params.readUInt16LE(i + 1);
      i += 3;
    }
    if (i + length > params.length) {
      break;
    }
    out.set(property, params.subarray(i, i + length));
    i += length;
  }
  return out;
}
function interpret(message, thermostats) {
  const t = thermostats.find(
    (x) => message.src === x.levelAddress || message.src === x.onOffAddress || message.src === x.sensorAddress || message.src === x.address
  );
  if (!t) {
    return [];
  }
  const p = message.params;
  switch (message.opcode) {
    case OP_GENERIC_LEVEL_STATUS:
      if (message.src !== t.levelAddress || p.length < 2) {
        return [];
      }
      return [
        {
          address: t.address,
          field: "setpoint",
          value: levelToCelsius(p.length >= 4 ? p.readInt16LE(2) : p.readInt16LE(0))
        }
      ];
    case OP_GENERIC_ONOFF_STATUS:
      if (message.src !== t.onOffAddress || p.length < 1) {
        return [];
      }
      return [{ address: t.address, field: "heating", value: (p.length >= 2 ? p[1] : p[0]) === 1 }];
    case OP_SENSOR_STATUS: {
      if (message.src !== t.sensorAddress) {
        return [];
      }
      const raw = parseSensorStatus(p).get(PROPERTY_TEMPERATURE_8);
      if (!raw || raw.length !== 1 || raw[0] === 127) {
        return [];
      }
      return [{ address: t.address, field: "temperature", value: raw.readInt8(0) * 0.5 }];
    }
    case OP_JUNG_ADMIN_STATUS: {
      if (p.length < 4 || p.readUInt16LE(0) !== PROPERTY_JUNG_OPERATING_MODE) {
        return [];
      }
      return [{ address: t.address, field: "mode", value: p[3] }];
    }
    default:
      return [];
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  OP_GENERIC_LEVEL_GET,
  OP_GENERIC_LEVEL_SET,
  OP_GENERIC_LEVEL_STATUS,
  OP_GENERIC_ONOFF_GET,
  OP_GENERIC_ONOFF_STATUS,
  OP_JUNG_ADMIN_STATUS,
  OP_SENSOR_GET,
  OP_SENSOR_STATUS,
  PROPERTY_JUNG_OPERATING_MODE,
  PROPERTY_TEMPERATURE_8,
  SETPOINT_MAX,
  SETPOINT_MIN,
  SETPOINT_STEP,
  celsiusToLevel,
  interpret,
  levelSetParams,
  levelToCelsius,
  roundSetpoint,
  sensorGetParams,
  validateSetpoint
});
//# sourceMappingURL=thermostat.js.map
