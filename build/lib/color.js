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
var color_exports = {};
__export(color_exports, {
  temperatureColor: () => temperatureColor
});
module.exports = __toCommonJS(color_exports);
const STOPS = [
  [18, [59, 130, 246]],
  // blue
  [21, [229, 231, 235]],
  // neutral
  [24, [249, 115, 22]]
  // orange
];
const hex2 = (n) => Math.round(n).toString(16).padStart(2, "0");
function temperatureColor(celsius) {
  if (celsius === null || !Number.isFinite(celsius)) {
    return "";
  }
  if (celsius <= STOPS[0][0]) {
    return `#${STOPS[0][1].map(hex2).join("")}`;
  }
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i];
    if (celsius <= t1) {
      const [t0, c0] = STOPS[i - 1];
      const f = (celsius - t0) / (t1 - t0);
      return `#${c0.map((v, k) => hex2(v + (c1[k] - v) * f)).join("")}`;
    }
  }
  return `#${STOPS[STOPS.length - 1][1].map(hex2).join("")}`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  temperatureColor
});
//# sourceMappingURL=color.js.map
