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
var telegram_exports = {};
__export(telegram_exports, {
  knownUsers: () => knownUsers,
  telegramPayload: () => telegramPayload
});
module.exports = __toCommonJS(telegram_exports);
function knownUsers(value) {
  try {
    const data = typeof value === "string" && value ? JSON.parse(value) : {};
    return new Set(data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data) : []);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function telegramPayload(text, target, button) {
  const payload = { text };
  if (target == null ? void 0 : target.user) {
    payload.user = target.user;
  }
  if ((target == null ? void 0 : target.chatId) !== void 0) {
    payload.chatId = target.chatId;
  }
  if (button) {
    payload.reply_markup = { inline_keyboard: [[{ text: button.label, callback_data: button.data }]] };
  }
  return payload;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  knownUsers,
  telegramPayload
});
//# sourceMappingURL=telegram.js.map
