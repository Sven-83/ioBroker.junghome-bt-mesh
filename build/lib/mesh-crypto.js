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
var mesh_crypto_exports = {};
__export(mesh_crypto_exports, {
  aesEcb: () => aesEcb,
  ccmDecrypt: () => ccmDecrypt,
  ccmEncrypt: () => ccmEncrypt,
  cmac: () => cmac,
  k2: () => k2,
  k4: () => k4,
  s1: () => s1,
  xor: () => xor
});
module.exports = __toCommonJS(mesh_crypto_exports);
var crypto = __toESM(require("node:crypto"));
function aesEcb(key, block) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}
function shiftLeft(block) {
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    out[i] = (block[i] << 1 | (i < 15 ? block[i + 1] >> 7 : 0)) & 255;
  }
  return out;
}
function xor(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] ^ b[i];
  }
  return out;
}
function cmac(key, message) {
  const l = aesEcb(key, Buffer.alloc(16));
  const k1 = shiftLeft(l);
  if (l[0] & 128) {
    k1[15] ^= 135;
  }
  const k22 = shiftLeft(k1);
  if (k1[0] & 128) {
    k22[15] ^= 135;
  }
  const blocks = Math.max(1, Math.ceil(message.length / 16));
  const complete = message.length > 0 && message.length % 16 === 0;
  let last;
  if (complete) {
    last = xor(message.subarray((blocks - 1) * 16), k1);
  } else {
    const padded = Buffer.alloc(16);
    message.subarray((blocks - 1) * 16).copy(padded);
    padded[message.length % 16] = 128;
    last = xor(padded, k22);
  }
  let x = Buffer.alloc(16);
  for (let i = 0; i < blocks - 1; i++) {
    x = aesEcb(key, xor(x, message.subarray(i * 16, i * 16 + 16)));
  }
  return aesEcb(key, xor(x, last));
}
function s1(text) {
  return cmac(Buffer.alloc(16), Buffer.from(text, "ascii"));
}
function k2(n, p) {
  const t = cmac(s1("smk2"), n);
  const t1 = cmac(t, Buffer.concat([p, Buffer.from([1])]));
  const t2 = cmac(t, Buffer.concat([t1, p, Buffer.from([2])]));
  const t3 = cmac(t, Buffer.concat([t2, p, Buffer.from([3])]));
  return { nid: t1[15] & 127, encryptionKey: t2, privacyKey: t3 };
}
function k4(n) {
  return cmac(cmac(s1("smk4"), n), Buffer.from("id6", "binary"))[15] & 63;
}
function ccmEncrypt(key, nonce, data, micLength) {
  const cipher = crypto.createCipheriv("aes-128-ccm", key, nonce, { authTagLength: micLength });
  const out = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([out, cipher.getAuthTag()]);
}
function ccmDecrypt(key, nonce, dataWithMic, micLength) {
  if (dataWithMic.length < micLength) {
    return null;
  }
  try {
    const decipher = crypto.createDecipheriv("aes-128-ccm", key, nonce, { authTagLength: micLength });
    decipher.setAuthTag(dataWithMic.subarray(dataWithMic.length - micLength));
    return Buffer.concat([
      decipher.update(dataWithMic.subarray(0, dataWithMic.length - micLength)),
      decipher.final()
    ]);
  } catch {
    return null;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  aesEcb,
  ccmDecrypt,
  ccmEncrypt,
  cmac,
  k2,
  k4,
  s1,
  xor
});
//# sourceMappingURL=mesh-crypto.js.map
