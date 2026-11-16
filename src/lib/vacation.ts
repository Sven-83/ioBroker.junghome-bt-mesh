/**
 * Vacation setback: lower all thermostats while nobody is at home and bring the previous
 * setpoints back a while before the return, because underfloor heating reacts slowly.
 * A setpoint changed by hand during the vacation counts as intended: that room leaves the setback.
 */

/** Persisted vacation setback */
export interface VacationState {
    /** Return (ms since epoch), 0 = open end (until switched off) */
    returnAt: number;
    /** Setpoint during the vacation */
    target: number;
    /** Hours before the return when the previous setpoints come back */
    preheatHours: number;
    /** Previous setpoint per thermostat (channel ID) that is still lowered */
    rooms: Record<string, number>;
    /** Rooms changed by hand during the vacation with their setpoint from before the vacation (to rejoin) */
    left: Record<string, number>;
}

/** Longest vacation that is accepted */
export const MAX_VACATION_DAYS = 366;

/**
 * Time when the previous setpoints come back, 0 for an open end.
 *
 * @param v Vacation
 */
export function preheatFrom(v: Pick<VacationState, 'returnAt' | 'preheatHours'>): number {
    return v.returnAt > 0 ? v.returnAt - v.preheatHours * 3_600_000 : 0;
}

/**
 * True when the setback has to end because the pre-heating time has come.
 *
 * @param v Vacation
 * @param now Current time
 */
export function vacationDue(v: Pick<VacationState, 'returnAt' | 'preheatHours'>, now: number): boolean {
    return v.returnAt > 0 && now >= preheatFrom(v);
}

/**
 * Reads a return time. Accepts ms since epoch, an ISO date/time, "YYYY-MM-DD" or "DD.MM.YYYY"
 * (a date without time means 00:00 local time). Empty or 0 means an open end.
 *
 * @param value Written value
 * @param now Current time
 */
export function parseReturnAt(value: unknown, now: number): { ok: true; at: number } | { ok: false; error: string } {
    if (value === null || value === undefined || value === '' || value === 0 || value === '0') {
        return { ok: true, at: 0 };
    }
    let at = NaN;
    if (typeof value === 'number') {
        at = value;
    } else if (typeof value === 'string') {
        const s = value.trim();
        let m: RegExpExecArray | null;
        if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
            at = localDate(+m[1], +m[2], +m[3]);
        } else if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})?(?:,?\s+(\d{1,2})(?::(\d{2}))?(?:\s*uhr)?)?$/i.exec(s))) {
            // German style, also "24.12." (next 24.12.) and "24.12. 18:00"
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
            error: `"${typeof value === 'string' ? value.slice(0, 40) : typeof value}" is not a valid return date`,
        };
    }
    if (at <= now) {
        return { ok: false, error: 'the return date is in the past' };
    }
    if (at > now + MAX_VACATION_DAYS * 86_400_000) {
        return { ok: false, error: `the return date is more than ${MAX_VACATION_DAYS} days away` };
    }
    return { ok: true, at };
}

function localDate(y: number, mo: number, d: number, h = 0, mi = 0): number {
    if (h > 23 || mi > 59) {
        return NaN;
    }
    const date = new Date(y, mo - 1, d, h, mi);
    // reject dates like 31.02. that Date would roll over
    return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date.getTime() : NaN;
}

/**
 * Decides which thermostats are lowered. Rooms without a known setpoint or already at or below the
 * vacation setpoint are left alone (nothing to restore later).
 *
 * @param rooms Thermostats with their normal setpoint (during a boost: the setpoint before the boost)
 * @param target Setpoint during the vacation
 */
export function planSetback(
    rooms: Array<{ id: string; setpoint: number | null }>,
    target: number,
): { lower: Record<string, number>; unknown: string[]; alreadyLow: string[] } {
    const lower: Record<string, number> = {};
    const unknown: string[] = [];
    const alreadyLow: string[] = [];
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

/**
 * Decides what a reported setpoint means during the vacation.
 * 'manual': someone changed a lowered room by hand, it leaves the setback.
 *
 * @param v Vacation
 * @param id Thermostat (channel ID)
 * @param reported Setpoint reported by the device
 * @param boostTarget Setpoint of a running boost of this room, null without boost
 */
export function vacationAfterReport(
    v: VacationState,
    id: string,
    reported: number,
    boostTarget: number | null,
): 'none' | 'keep' | 'manual' {
    if (!(id in v.rooms)) {
        return 'none';
    }
    if (Math.abs(reported - v.target) < 0.01) {
        return 'keep';
    }
    if (boostTarget !== null && Math.abs(reported - boostTarget) < 0.01) {
        return 'keep';
    }
    return 'manual';
}

function setpointMap(value: unknown): Record<string, number> | null {
    if (value === undefined) {
        return {};
    }
    if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.values(value).every(n => typeof n === 'number' && Number.isFinite(n))
    ) {
        return { ...(value as Record<string, number>) };
    }
    return null;
}

/**
 * Restores the vacation from its persisted JSON. Invalid content gives null.
 *
 * @param json Stored value
 */
export function parseVacation(json: unknown): VacationState | null {
    if (typeof json !== 'string' || json === '') {
        return null;
    }
    try {
        const v = JSON.parse(json) as Partial<VacationState>;
        const rooms = v.rooms === undefined ? null : setpointMap(v.rooms);
        const left = setpointMap(v.left);
        if (
            typeof v.returnAt === 'number' &&
            typeof v.target === 'number' &&
            typeof v.preheatHours === 'number' &&
            Number.isFinite(v.returnAt + v.target + v.preheatHours) &&
            rooms &&
            left
        ) {
            return { returnAt: v.returnAt, target: v.target, preheatHours: v.preheatHours, rooms, left };
        }
    } catch {
        // fall through
    }
    return null;
}

/**
 * Takes a lowered room out of the setback and remembers its setpoint from before the vacation.
 *
 * @param v Vacation (changed in place)
 * @param id Thermostat (channel ID)
 */
export function leaveSetback(v: VacationState, id: string): boolean {
    if (!(id in v.rooms)) {
        return false;
    }
    v.left[id] = v.rooms[id];
    delete v.rooms[id];
    return true;
}

/**
 * Setpoint to come back to when a room rejoins the setback: the one from before the vacation,
 * else the current setpoint. Null when the room cannot rejoin (nothing above the vacation setpoint to restore).
 *
 * @param v Vacation
 * @param id Thermostat (channel ID)
 * @param current Current setpoint of the room
 */
export function rejoinPrevious(v: VacationState, id: string, current: number | null): number | null {
    if (id in v.rooms) {
        return null;
    }
    const previous = id in v.left ? v.left[id] : current;
    return previous !== null && Number.isFinite(previous) && previous > v.target + 0.01 ? previous : null;
}

/** A vacation command typed into Telegram */
export type VacationCommand =
    { kind: 'on'; returnAt: string } | { kind: 'off' } | { kind: 'status' } | { kind: 'rejoin'; address: string };

/** Prefix of the callback data of the "rejoin" button */
export const REJOIN_PREFIX = 'jhbm:rejoin:';

/**
 * Reads a Telegram message: "Urlaub", "Urlaub bis 24.12.", "Urlaub 24.12.2026 18:00", "Urlaub aus",
 * "Urlaub Status" (also English "vacation ...") or the data of the rejoin button.
 * The telegram adapter puts the sender in front: "[Name]Urlaub aus".
 *
 * @param request Value of telegram.N.communicate.request
 */
export function parseVacationCommand(request: unknown): VacationCommand | null {
    if (typeof request !== 'string') {
        return null;
    }
    const text = request.replace(/^\[[^\]]*\]/, '').trim();
    const rejoin = new RegExp(`^${REJOIN_PREFIX}([0-9A-F]{4})$`).exec(text);
    if (rejoin) {
        return { kind: 'rejoin', address: rejoin[1] };
    }
    const m = /^\/?(?:urlaub|vacation)\b\s*(.*)$/i.exec(text);
    if (!m) {
        return null;
    }
    const rest = m[1].trim().toLowerCase();
    if (/^(aus|ende|beenden|stop|off|end)$/.test(rest)) {
        return { kind: 'off' };
    }
    if (/^(status|\?|info)$/.test(rest)) {
        return { kind: 'status' };
    }
    if (/^(an|ein|start|on)?$/.test(rest)) {
        return { kind: 'on', returnAt: '' };
    }
    return { kind: 'on', returnAt: rest.replace(/^(bis|until)\s+/, '') };
}

/**
 * Short local date and time, e.g. "24.12. 18:00".
 *
 * @param ms Time
 * @param german German format
 */
export function shortTime(ms: number, german: boolean): string {
    const d = new Date(ms);
    const p = (n: number): string => String(n).padStart(2, '0');
    const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
    return german ? `${p(d.getDate())}.${p(d.getMonth() + 1)}. ${time}` : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

const c = (n: number, german: boolean): string => (german ? n.toFixed(1).replace('.', ',') : n.toFixed(1));

/**
 * Status of the vacation setback for Telegram.
 *
 * @param v Vacation, null when off
 * @param german German text
 * @param nameOf Room name of a channel ID
 */
export function statusText(v: VacationState | null, german: boolean, nameOf: (id: string) => string): string {
    if (!v) {
        return german ? '🏠 Urlaubsabsenkung ist aus.' : '🏠 Vacation setback is off.';
    }
    const lowered = Object.keys(v.rooms).map(nameOf).join(', ');
    const left = Object.keys(v.left).map(nameOf).join(', ');
    if (german) {
        return [
            `🧳 Urlaubsabsenkung läuft (${c(v.target, true)} °C).`,
            v.returnAt
                ? `Rückkehr ${shortTime(v.returnAt, true)}, vorheizen ab ${shortTime(preheatFrom(v), true)}.`
                : 'Ohne Rückkehrdatum – endet mit „Urlaub aus“.',
            `Abgesenkt: ${lowered || '–'}`,
            ...(left ? [`Von Hand verstellt: ${left}`] : []),
        ].join('\n');
    }
    return [
        `🧳 Vacation setback is on (${c(v.target, false)} °C).`,
        v.returnAt
            ? `Return ${shortTime(v.returnAt, false)}, pre-heating from ${shortTime(preheatFrom(v), false)}.`
            : 'No return date – ends with "vacation off".',
        `Lowered: ${lowered || '–'}`,
        ...(left ? [`Changed by hand: ${left}`] : []),
    ].join('\n');
}

/**
 * Text of the message sent when a room is changed by hand during the vacation.
 *
 * @param german German text
 * @param room Room name from the JUNG HOME export
 * @param celsius New setpoint
 * @param atDevice Changed at the thermostat (true) or through ioBroker (false)
 */
export function manualChangeText(german: boolean, room: string, celsius: number, atDevice: boolean): string {
    if (german) {
        return (
            `🌡️ Heizung im Urlaub: ${room} wurde ${atDevice ? 'am Thermostat' : 'über ioBroker'} auf ` +
            `${c(celsius, true)} °C gestellt. Die Änderung gilt als gewollt, der Raum ist aus der ` +
            `Urlaubsabsenkung genommen.`
        );
    }
    return (
        `🌡️ Heating on vacation: ${room} was set to ${c(celsius, false)} °C ${atDevice ? 'at the thermostat' : 'through ioBroker'}. ` +
        `The change counts as intended, the room has left the vacation setback.`
    );
}

/**
 * Label of the rejoin button.
 *
 * @param german German text
 */
export function rejoinButton(german: boolean): string {
    return german ? '↩️ Zurück in die Urlaubsabsenkung' : '↩️ Back to the vacation setback';
}

/**
 * Answer after a rejoin.
 *
 * @param german German text
 * @param room Room name
 * @param target Vacation setpoint
 * @param previous Setpoint that comes back at the end
 */
export function rejoinText(german: boolean, room: string, target: number, previous: number): string {
    return german
        ? `↩️ ${room} ist wieder in der Urlaubsabsenkung (${c(target, true)} °C), danach zurück auf ${c(previous, true)} °C.`
        : `↩️ ${room} is back in the vacation setback (${c(target, false)} °C), afterwards back to ${c(previous, false)} °C.`;
}
