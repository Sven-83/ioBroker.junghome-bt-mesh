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
  REJOIN_PREFIX: () => REJOIN_PREFIX,
  leaveSetback: () => leaveSetback,
  manualChangeText: () => manualChangeText,
  parseReturnAt: () => parseReturnAt,
  parseVacation: () => parseVacation,
  parseVacationCommand: () => parseVacationCommand,
  planSetback: () => planSetback,
  preheatFrom: () => preheatFrom,
  rejoinButton: () => rejoinButton,
  rejoinPrevious: () => rejoinPrevious,
  rejoinText: () => rejoinText,
  shortTime: () => shortTime,
  statusText: () => statusText,
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
    } else if (m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})?(?:,?\s+(\d{1,2})(?::(\d{2}))?(?:\s*uhr)?)?$/i.exec(s)) {
      const [d, mo, h, mi] = [+m[1], +m[2], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0];
      if (m[3]) {
        at = localDate(+m[3], mo, d, h, mi);
      } else {
        const year = new Date(now).getFullYear();
        at = localDate(year, mo, d, h, mi);
        if (Number.isFinite(at) && at <= now) {
          at = localDate(year + 1, mo, d, h, mi);
        }
      }
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
function localDate(y, mo, d, h = 0, mi = 0) {
  if (h > 23 || mi > 59) {
    return NaN;
  }
  const date = new Date(y, mo - 1, d, h, mi);
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
function setpointMap(value) {
  if (value === void 0) {
    return {};
  }
  if (value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((n) => typeof n === "number" && Number.isFinite(n))) {
    return { ...value };
  }
  return null;
}
function parseVacation(json) {
  if (typeof json !== "string" || json === "") {
    return null;
  }
  try {
    const v = JSON.parse(json);
    const rooms = v.rooms === void 0 ? null : setpointMap(v.rooms);
    const left = setpointMap(v.left);
    if (typeof v.returnAt === "number" && typeof v.target === "number" && typeof v.preheatHours === "number" && Number.isFinite(v.returnAt + v.target + v.preheatHours) && rooms && left) {
      return { returnAt: v.returnAt, target: v.target, preheatHours: v.preheatHours, rooms, left };
    }
  } catch {
  }
  return null;
}
function leaveSetback(v, id) {
  if (!(id in v.rooms)) {
    return false;
  }
  v.left[id] = v.rooms[id];
  delete v.rooms[id];
  return true;
}
function rejoinPrevious(v, id, current) {
  if (id in v.rooms) {
    return null;
  }
  const previous = id in v.left ? v.left[id] : current;
  return previous !== null && Number.isFinite(previous) && previous > v.target + 0.01 ? previous : null;
}
const REJOIN_PREFIX = "jhbm:rejoin:";
function parseVacationCommand(request) {
  if (typeof request !== "string") {
    return null;
  }
  const text = request.replace(/^\[[^\]]*\]/, "").trim();
  const rejoin = new RegExp(`^${REJOIN_PREFIX}([0-9A-F]{4})$`).exec(text);
  if (rejoin) {
    return { kind: "rejoin", address: rejoin[1] };
  }
  const m = /^\/?(?:urlaub|vacation)\b\s*(.*)$/i.exec(text);
  if (!m) {
    return null;
  }
  const rest = m[1].trim().toLowerCase();
  if (/^(aus|ende|beenden|stop|off|end)$/.test(rest)) {
    return { kind: "off" };
  }
  if (/^(status|\?|info)$/.test(rest)) {
    return { kind: "status" };
  }
  if (/^(an|ein|start|on)?$/.test(rest)) {
    return { kind: "on", returnAt: "" };
  }
  return { kind: "on", returnAt: rest.replace(/^(bis|until)\s+/, "") };
}
function shortTime(ms, german) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return german ? `${p(d.getDate())}.${p(d.getMonth() + 1)}. ${time}` : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}
const c = (n, german) => german ? n.toFixed(1).replace(".", ",") : n.toFixed(1);
function statusText(v, german, nameOf) {
  if (!v) {
    return german ? "\u{1F3E0} Urlaubsabsenkung ist aus." : "\u{1F3E0} Vacation setback is off.";
  }
  const lowered = Object.keys(v.rooms).map(nameOf).join(", ");
  const left = Object.keys(v.left).map(nameOf).join(", ");
  if (german) {
    return [
      `\u{1F9F3} Urlaubsabsenkung l\xE4uft (${c(v.target, true)} \xB0C).`,
      v.returnAt ? `R\xFCckkehr ${shortTime(v.returnAt, true)}, vorheizen ab ${shortTime(preheatFrom(v), true)}.` : "Ohne R\xFCckkehrdatum \u2013 endet mit \u201EUrlaub aus\u201C.",
      `Abgesenkt: ${lowered || "\u2013"}`,
      ...left ? [`Von Hand verstellt: ${left}`] : []
    ].join("\n");
  }
  return [
    `\u{1F9F3} Vacation setback is on (${c(v.target, false)} \xB0C).`,
    v.returnAt ? `Return ${shortTime(v.returnAt, false)}, pre-heating from ${shortTime(preheatFrom(v), false)}.` : 'No return date \u2013 ends with "vacation off".',
    `Lowered: ${lowered || "\u2013"}`,
    ...left ? [`Changed by hand: ${left}`] : []
  ].join("\n");
}
function manualChangeText(german, room, celsius, atDevice) {
  if (german) {
    return `\u{1F321}\uFE0F Heizung im Urlaub: ${room} wurde ${atDevice ? "am Thermostat" : "\xFCber ioBroker"} auf ${c(celsius, true)} \xB0C gestellt. Die \xC4nderung gilt als gewollt, der Raum ist aus der Urlaubsabsenkung genommen.`;
  }
  return `\u{1F321}\uFE0F Heating on vacation: ${room} was set to ${c(celsius, false)} \xB0C ${atDevice ? "at the thermostat" : "through ioBroker"}. The change counts as intended, the room has left the vacation setback.`;
}
function rejoinButton(german) {
  return german ? "\u21A9\uFE0F Zur\xFCck in die Urlaubsabsenkung" : "\u21A9\uFE0F Back to the vacation setback";
}
function rejoinText(german, room, target, previous) {
  return german ? `\u21A9\uFE0F ${room} ist wieder in der Urlaubsabsenkung (${c(target, true)} \xB0C), danach zur\xFCck auf ${c(previous, true)} \xB0C.` : `\u21A9\uFE0F ${room} is back in the vacation setback (${c(target, false)} \xB0C), afterwards back to ${c(previous, false)} \xB0C.`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_VACATION_DAYS,
  REJOIN_PREFIX,
  leaveSetback,
  manualChangeText,
  parseReturnAt,
  parseVacation,
  parseVacationCommand,
  planSetback,
  preheatFrom,
  rejoinButton,
  rejoinPrevious,
  rejoinText,
  shortTime,
  statusText,
  vacationAfterReport,
  vacationDue
});
//# sourceMappingURL=vacation.js.map
