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
var boost_exports = {};
__export(boost_exports, {
  boostAfterReport: () => boostAfterReport,
  boostRemaining: () => boostRemaining,
  parseBoost: () => parseBoost,
  startBoost: () => startBoost
});
module.exports = __toCommonJS(boost_exports);
function startBoost(now, currentSetpoint, minutes, target) {
  if (currentSetpoint === null || !Number.isFinite(currentSetpoint)) {
    return null;
  }
  return { until: now + minutes * 6e4, previous: currentSetpoint, target };
}
function boostAfterReport(boost, reportedSetpoint) {
  return Math.abs(reportedSetpoint - boost.target) < 0.01 ? "keep" : "cancel";
}
function boostRemaining(boost, now) {
  return Math.max(0, boost.until - now);
}
function parseBoost(json) {
  if (typeof json !== "string" || json === "") {
    return null;
  }
  try {
    const b = JSON.parse(json);
    if (typeof b.until === "number" && typeof b.previous === "number" && typeof b.target === "number" && Number.isFinite(b.until + b.previous + b.target)) {
      return { until: b.until, previous: b.previous, target: b.target };
    }
  } catch {
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  boostAfterReport,
  boostRemaining,
  parseBoost,
  startBoost
});
//# sourceMappingURL=boost.js.map
