"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var test_export_test_helper_exports = {};
__export(test_export_test_helper_exports, {
  buildExport: () => buildExport
});
module.exports = __toCommonJS(test_export_test_helper_exports);
var crypto = __toESM(require("node:crypto"));
function buildExport(keys) {
  var _a, _b, _c;
  const k = {
    netKey: (_a = keys == null ? void 0 : keys.netKey) != null ? _a : crypto.randomBytes(16).toString("hex"),
    appKey: (_b = keys == null ? void 0 : keys.appKey) != null ? _b : crypto.randomBytes(16).toString("hex"),
    devKey: (_c = keys == null ? void 0 : keys.devKey) != null ? _c : crypto.randomBytes(16).toString("hex")
  };
  const network = {
    netKeys: [{ index: 0, key: k.netKey }],
    appKeys: [{ index: 0, key: k.appKey }],
    networkExclusions: [{ addresses: [], ivIndex: 0 }],
    provisioners: [
      { provisionerName: "Phone", allocatedUnicastRange: [{ lowAddress: "0001", highAddress: "0CCD" }] }
    ],
    nodes: [
      {
        UUID: "AAAAAAAA-0000-0000-0000-000000000001",
        unicastAddress: "0001",
        deviceKey: crypto.randomBytes(16).toString("hex"),
        name: "Phone",
        elements: [{ models: [{ modelId: "0001" }, { modelId: "1001" }] }]
      },
      {
        UUID: "11223344-5566-7788-0000-000000000000",
        unicastAddress: "0006",
        deviceKey: k.devKey,
        name: "Room thermostat",
        elements: [
          { models: [{ modelId: "0000" }, { modelId: "1002" }] },
          { models: [{ modelId: "1000" }] },
          { models: [{ modelId: "1100" }] }
        ]
      }
    ]
  };
  const outer = {
    meta: {
      devices: [
        {
          macAddress: "aa:bb:cc:dd:ee:01",
          name: "Test room",
          deviceId: { nodeId: "11223344-5566-7788-0000-000000000000" }
        }
      ]
    },
    network: Buffer.from(JSON.stringify(network)).toString("base64"),
    version: "1.1"
  };
  return { text: JSON.stringify(outer), keys: k };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildExport
});
//# sourceMappingURL=test-export.test-helper.js.map
