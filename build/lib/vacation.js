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
var vacation_exports = {};
__export(vacation_exports, {
  MAX_VACATION_DAYS: () => MAX_VACATION_DAYS,
  manualChangeText: () => manualChangeText,
  parseReturnAt: () => parseReturnAt,
  parseVacation: () => parseVacation,
  planSetback: () => planSetback,
  preheatFrom: () => preheatFrom,
  vacationAfterReport: () => vacationAfterReport,
  vacationDue: () => vacationDue
});
module.exports = __toCommonJS(vacation_exports);
const MAX_VACATION_DAYS = 366;
function preheatFrom(v) {
  return v.returnAt > 0 ? v.returnAt - v.preheatHours * 36e5 : 0;
}
function vacationDue(v, now) {
  return v.returnAt > 0 && now >= preheatFrom(v);
}
function parseReturnAt(value, now) {
  if (value === null || value === void 0 || value === "" || value === 0 || value === "0") {
    return { ok: true, at: 0 };
  }
  let at = NaN;
  if (typeof value === "number") {
    at = value;
  } else if (typeof value === "string") {
    const s = value.trim();
    let m;
    if (m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)) {
      at = localDate(+m[1], +m[2], +m[3]);
    } else if (m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s)) {
      at = localDate(+m[3], +m[2], +m[1]);
    } else if (/^\d+$/.test(s)) {
      at = Number(s);
    } else {
      at = Date.parse(s);
    }
  }
  if (!Number.isFinite(at)) {
    return {
      ok: false,
      error: `"${typeof value === "string" ? value.slice(0, 40) : typeof value}" is not a valid return date`
    };
  }
  if (at <= now) {
    return { ok: false, error: "the return date is in the past" };
  }
  if (at > now + MAX_VACATION_DAYS * 864e5) {
    return { ok: false, error: `the return date is more than ${MAX_VACATION_DAYS} days away` };
  }
  return { ok: true, at };
}
function localDate(y, mo, d) {
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date.getTime() : NaN;
}
function planSetback(rooms, target) {
  const lower = {};
  const unknown = [];
  const alreadyLow = [];
  for (const r of rooms) {
    if (r.setpoint === null || !Number.isFinite(r.setpoint)) {
      unknown.push(r.id);
    } else if (r.setpoint <= target + 0.01) {
      alreadyLow.push(r.id);
    } else {
      lower[r.id] = r.setpoint;
    }
  }
  return { lower, unknown, alreadyLow };
}
function vacationAfterReport(v, id, reported, boostTarget) {
  if (!(id in v.rooms)) {
    return "none";
  }
  if (Math.abs(reported - v.target) < 0.01) {
    return "keep";
  }
  if (boostTarget !== null && Math.abs(reported - boostTarget) < 0.01) {
    return "keep";
  }
  return "manual";
}
function parseVacation(json) {
  if (typeof json !== "string" || json === "") {
    return null;
  }
  try {
    const v = JSON.parse(json);
    if (typeof v.returnAt === "number" && typeof v.target === "number" && typeof v.preheatHours === "number" && Number.isFinite(v.returnAt + v.target + v.preheatHours) && v.rooms && typeof v.rooms === "object" && !Array.isArray(v.rooms) && Object.values(v.rooms).every((n) => typeof n === "number" && Number.isFinite(n))) {
      return { returnAt: v.returnAt, target: v.target, preheatHours: v.preheatHours, rooms: { ...v.rooms } };
    }
  } catch {
  }
  return null;
}
function manualChangeText(german, room, celsius, atDevice) {
  const t = celsius.toFixed(1);
  if (german) {
    return `\u{1F321}\uFE0F Heizung im Urlaub: ${room} wurde ${atDevice ? "am Thermostat" : "\xFCber ioBroker"} auf ${t.replace(".", ",")} \xB0C gestellt. Die \xC4nderung gilt als gewollt, der Raum ist aus der Urlaubsabsenkung genommen.`;
  }
  return `\u{1F321}\uFE0F Heating on vacation: ${room} was set to ${t} \xB0C ${atDevice ? "at the thermostat" : "through ioBroker"}. The change counts as intended, the room has left the vacation setback.`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_VACATION_DAYS,
  manualChangeText,
  parseReturnAt,
  parseVacation,
  planSetback,
  preheatFrom,
  vacationAfterReport,
  vacationDue
});
//# sourceMappingURL=vacation.js.map
