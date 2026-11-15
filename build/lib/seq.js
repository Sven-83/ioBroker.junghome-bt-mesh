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
var seq_exports = {};
__export(seq_exports, {
  SEQ_BLOCK: () => SEQ_BLOCK,
  SEQ_LIMIT: () => SEQ_LIMIT,
  SeqAllocator: () => SeqAllocator
});
module.exports = __toCommonJS(seq_exports);
const SEQ_BLOCK = 256;
const SEQ_LIMIT = 16777215;
class SeqAllocator {
  /**
   * @param persistedReserve Value stored by the last run (0 for a fresh start)
   * @param persist Stores a new reserve; called synchronously before numbers of the block are used
   */
  constructor(persistedReserve, persist) {
    this.persist = persist;
    const start = Number.isInteger(persistedReserve) && persistedReserve > 0 ? persistedReserve : 0;
    this.next = start;
    this.reservedUpTo = start;
  }
  next;
  reservedUpTo;
  /** Next free number; throws when the 24-bit space is used up (needs an IV update) */
  take() {
    if (this.next >= SEQ_LIMIT) {
      throw new Error("sequence numbers exhausted");
    }
    if (this.next >= this.reservedUpTo - SEQ_BLOCK / 2) {
      this.reservedUpTo = Math.min(SEQ_LIMIT, Math.max(this.reservedUpTo, this.next) + SEQ_BLOCK);
      this.persist(this.reservedUpTo);
    }
    return this.next++;
  }
  /** The value that has to be persisted at minimum */
  get reserve() {
    return this.reservedUpTo;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SEQ_BLOCK,
  SEQ_LIMIT,
  SeqAllocator
});
//# sourceMappingURL=seq.js.map
