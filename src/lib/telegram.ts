/**
 * Helpers for the telegram adapter (messages, inline button, known users).
 */

/**
 * Chat/user IDs the telegram instance knows, from telegram.N.communicate.users ({"<id>": {firstName, userName}}).
 *
 * @param value State value
 */
export function knownUsers(value: unknown): Set<string> {
    try {
        const data: unknown = typeof value === 'string' && value ? JSON.parse(value) : {};
        return new Set(data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : []);
    } catch {
        return new Set();
    }
}

/**
 * Message payload for the telegram "send" command, optionally with one inline button.
 *
 * @param text Message
 * @param target Receiver: user name or chat ID, undefined = all users
 * @param target.user Telegram user name
 * @param target.chatId Chat ID (answer to a request)
 * @param button Inline button (label and callback data)
 * @param button.label Label of the button
 * @param button.data Callback data (max 64 bytes)
 */
export function telegramPayload(
    text: string,
    target?: { user?: string; chatId?: string | number },
    button?: { label: string; data: string },
): Record<string, unknown> {
    const payload: Record<string, unknown> = { text };
    if (target?.user) {
        payload.user = target.user;
    }
    if (target?.chatId !== undefined) {
        payload.chatId = target.chatId;
    }
    if (button) {
        payload.reply_markup = { inline_keyboard: [[{ text: button.label, callback_data: button.data }]] };
    }
    return payload;
}
