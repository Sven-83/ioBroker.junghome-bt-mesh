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
        } else if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s))) {
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

function localDate(y: number, mo: number, d: number): number {
    const date = new Date(y, mo - 1, d);
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
        if (
            typeof v.returnAt === 'number' &&
            typeof v.target === 'number' &&
            typeof v.preheatHours === 'number' &&
            Number.isFinite(v.returnAt + v.target + v.preheatHours) &&
            v.rooms &&
            typeof v.rooms === 'object' &&
            !Array.isArray(v.rooms) &&
            Object.values(v.rooms).every(n => typeof n === 'number' && Number.isFinite(n))
        ) {
            return { returnAt: v.returnAt, target: v.target, preheatHours: v.preheatHours, rooms: { ...v.rooms } };
        }
    } catch {
        // fall through
    }
    return null;
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
    const t = celsius.toFixed(1);
    if (german) {
        return (
            `🌡️ Heizung im Urlaub: ${room} wurde ${atDevice ? 'am Thermostat' : 'über ioBroker'} auf ` +
            `${t.replace('.', ',')} °C gestellt. Die Änderung gilt als gewollt, der Raum ist aus der ` +
            `Urlaubsabsenkung genommen.`
        );
    }
    return (
        `🌡️ Heating on vacation: ${room} was set to ${t} °C ${atDevice ? 'at the thermostat' : 'through ioBroker'}. ` +
        `The change counts as intended, the room has left the vacation setback.`
    );
}
