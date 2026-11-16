import { expect } from 'chai';
import {
    MAX_VACATION_DAYS,
    REJOIN_PREFIX,
    leaveSetback,
    manualChangeText,
    parseVacationCommand,
    rejoinPrevious,
    rejoinText,
    statusText,
    parseReturnAt,
    parseSpokenDate,
    parseVacation,
    planSetback,
    preheatFrom,
    vacationAfterReport,
    vacationDue,
    type VacationState,
} from './vacation';

const H = 3_600_000;
const NOW = new Date(2026, 10, 16, 12, 0).getTime();

const V: VacationState = {
    returnAt: NOW + 72 * H,
    target: 17,
    preheatHours: 24,
    rooms: { 'thermostats.0006': 21 },
    left: {},
};

describe('vacation', () => {
    it('brings the setpoints back the given hours before the return', () => {
        expect(preheatFrom(V)).to.equal(NOW + 48 * H);
        expect(vacationDue(V, NOW + 48 * H - 1)).to.equal(false);
        expect(vacationDue(V, NOW + 48 * H)).to.equal(true);
    });

    it('never ends by itself with an open end', () => {
        const open = { ...V, returnAt: 0 };
        expect(preheatFrom(open)).to.equal(0);
        expect(vacationDue(open, NOW + 1000 * H)).to.equal(false);
    });

    it('reads return dates in several forms', () => {
        expect(parseReturnAt(0, NOW)).to.deep.equal({ ok: true, at: 0 });
        expect(parseReturnAt('', NOW)).to.deep.equal({ ok: true, at: 0 });
        expect(parseReturnAt(null, NOW)).to.deep.equal({ ok: true, at: 0 });
        expect(parseReturnAt(NOW + H, NOW)).to.deep.equal({ ok: true, at: NOW + H });
        expect(parseReturnAt(String(NOW + H), NOW)).to.deep.equal({ ok: true, at: NOW + H });
        const day = new Date(2026, 11, 24).getTime();
        expect(parseReturnAt('2026-12-24', NOW)).to.deep.equal({ ok: true, at: day });
        expect(parseReturnAt('24.12.2026', NOW)).to.deep.equal({ ok: true, at: day });
        const iso = '2026-12-24T18:30:00Z';
        expect(parseReturnAt(iso, NOW)).to.deep.equal({ ok: true, at: Date.parse(iso) });
    });

    it('rejects past, far-away and impossible dates', () => {
        expect(parseReturnAt(NOW - 1, NOW).ok).to.equal(false);
        expect(parseReturnAt(NOW + (MAX_VACATION_DAYS + 1) * 24 * H, NOW).ok).to.equal(false);
        expect(parseReturnAt('31.02.2027', NOW).ok).to.equal(false);
        expect(parseReturnAt('soon', NOW).ok).to.equal(false);
        expect(parseReturnAt(true, NOW).ok).to.equal(false);
    });

    it('lowers only rooms above the vacation setpoint with a known setpoint', () => {
        const plan = planSetback(
            [
                { id: 'a', setpoint: 21 },
                { id: 'b', setpoint: 17 },
                { id: 'c', setpoint: 16 },
                { id: 'd', setpoint: null },
            ],
            17,
        );
        expect(plan.lower).to.deep.equal({ a: 21 });
        expect(plan.alreadyLow).to.deep.equal(['b', 'c']);
        expect(plan.unknown).to.deep.equal(['d']);
    });

    it('takes a different setpoint of a lowered room as a change by hand', () => {
        expect(vacationAfterReport(V, 'thermostats.0006', 17, null)).to.equal('keep');
        expect(vacationAfterReport(V, 'thermostats.0006', 19.5, null)).to.equal('manual');
        expect(vacationAfterReport(V, 'thermostats.0007', 19.5, null)).to.equal('none');
    });

    it('lets a boost run during the vacation', () => {
        expect(vacationAfterReport(V, 'thermostats.0006', 30, 30)).to.equal('keep');
        expect(vacationAfterReport(V, 'thermostats.0006', 25, 30)).to.equal('manual');
    });

    it('survives a restart and rejects broken data', () => {
        expect(parseVacation(JSON.stringify(V))).to.deep.equal(V);
        expect(parseVacation('')).to.equal(null);
        expect(parseVacation('{')).to.equal(null);
        expect(parseVacation(JSON.stringify({ ...V, rooms: [] }))).to.equal(null);
        expect(parseVacation(JSON.stringify({ ...V, rooms: { a: 'x' } }))).to.equal(null);
        expect(parseVacation(JSON.stringify({ ...V, target: undefined }))).to.equal(null);
    });

    it('names the room and the new setpoint in the message', () => {
        const de = manualChangeText(true, 'Raum A', 19.5, true);
        expect(de).to.include('Raum A').and.include('19,5 °C').and.include('am Thermostat');
        const en = manualChangeText(false, 'Room A', 20, false);
        expect(en).to.include('Room A').and.include('20.0 °C').and.include('through ioBroker');
    });
    it('reads short German dates for Telegram', () => {
        expect(parseReturnAt('24.12.', NOW)).to.deep.equal({ ok: true, at: new Date(2026, 11, 24).getTime() });
        expect(parseReturnAt('24.12. 18:00', NOW)).to.deep.equal({
            ok: true,
            at: new Date(2026, 11, 24, 18, 0).getTime(),
        });
        expect(parseReturnAt('24.12.2026, 18 Uhr', NOW)).to.deep.equal({
            ok: true,
            at: new Date(2026, 11, 24, 18, 0).getTime(),
        });
        // a day already passed this year means next year
        expect(parseReturnAt('2.1.', NOW)).to.deep.equal({ ok: true, at: new Date(2027, 0, 2).getTime() });
        expect(parseReturnAt('24.12. 25:00', NOW).ok).to.equal(false);
    });

    it('remembers the original setpoint of a room that left, for rejoining', () => {
        const v: VacationState = { ...V, rooms: { a: 21 }, left: {} };
        expect(leaveSetback(v, 'a')).to.equal(true);
        expect(v.rooms).to.deep.equal({});
        expect(v.left).to.deep.equal({ a: 21 });
        expect(leaveSetback(v, 'a')).to.equal(false);
        // rejoin brings back the setpoint from before the vacation, not the one set by hand
        expect(rejoinPrevious(v, 'a', 17.5)).to.equal(21);
        // a room that was never lowered uses its current setpoint
        expect(rejoinPrevious(v, 'b', 22)).to.equal(22);
        expect(rejoinPrevious(v, 'b', 16)).to.equal(null);
        expect(rejoinPrevious(v, 'b', null)).to.equal(null);
        expect(rejoinPrevious({ ...v, rooms: { b: 21 } }, 'b', 22)).to.equal(null);
    });

    it('reads older stored data without the list of rooms that left', () => {
        const old = JSON.stringify({ returnAt: 1, target: 17, preheatHours: 0, rooms: { a: 21 } });
        expect(parseVacation(old)?.left).to.deep.equal({});
        expect(parseVacation(JSON.stringify({ ...V, left: { a: 'x' } }))).to.equal(null);
    });

    it('understands Telegram commands', () => {
        expect(parseVacationCommand('[Sven]Urlaub')).to.deep.equal({ kind: 'on', returnAt: '' });
        expect(parseVacationCommand('[Sven]urlaub an')).to.deep.equal({ kind: 'on', returnAt: '' });
        expect(parseVacationCommand('[Sven]Urlaub bis 24.12.')).to.deep.equal({ kind: 'on', returnAt: '24.12.' });
        expect(parseVacationCommand('[Sven]Urlaub 24.12. 18:00')).to.deep.equal({
            kind: 'on',
            returnAt: '24.12. 18:00',
        });
        expect(parseVacationCommand('[Sven]Urlaub aus')).to.deep.equal({ kind: 'off' });
        expect(parseVacationCommand('[Sven]/urlaub status')).to.deep.equal({ kind: 'status' });
        expect(parseVacationCommand('[Sven]Urlaub?')).to.deep.equal({ kind: 'status' });
        expect(parseVacationCommand('[x]vacation off')).to.deep.equal({ kind: 'off' });
        expect(parseVacationCommand(`[Sven]${REJOIN_PREFIX}0006`)).to.deep.equal({ kind: 'rejoin', address: '0006' });
        expect(parseVacationCommand('[Sven]Laden 14 kWh')).to.equal(null);
        expect(parseVacationCommand('[Sven]Urlaubsfotos')).to.equal(null);
        expect(parseVacationCommand(42)).to.equal(null);
    });

    it('describes the state for Telegram', () => {
        const name = (id: string): string => (id === 'a' ? 'Raum A' : 'Raum B');
        expect(statusText(null, true, name)).to.include('aus');
        const v: VacationState = {
            ...V,
            returnAt: new Date(2026, 11, 24).getTime(),
            rooms: { a: 21 },
            left: { b: 22 },
        };
        const de = statusText(v, true, name);
        expect(de).to.include('17,0 °C').and.include('Rückkehr 24.12. 00:00').and.include('vorheizen ab 23.12. 00:00');
        expect(de).to.include('Abgesenkt: Raum A').and.include('Von Hand verstellt: Raum B');
        expect(statusText({ ...v, returnAt: 0 }, false, name)).to.include('No return date');
        expect(rejoinText(true, 'Raum A', 17, 21))
            .to.include('17,0 °C')
            .and.include('21,0 °C');
    });
    it('reads dates the way people type them into Telegram', () => {
        // NOW is Monday 16.11.2026 12:00
        const d = (y: number, mo: number, day: number, h = 0, mi = 0): number =>
            new Date(y, mo - 1, day, h, mi).getTime();
        const cases: Array<[string, number]> = [
            ['16.11 18:30', d(2026, 11, 16, 18, 30)],
            ['16.11. 18.30', d(2026, 11, 16, 18, 30)],
            ['24.12.26', d(2026, 12, 24)],
            ['24.12.26 18 Uhr', d(2026, 12, 24, 18)],
            ['zum 24.12. um 18 Uhr', d(2026, 12, 24, 18)],
            ['18:00', d(2026, 11, 16, 18)],
            ['18 Uhr', d(2026, 11, 16, 18)],
            ['18.30', d(2026, 11, 16, 18, 30)],
            ['9:00', d(2026, 11, 17, 9)], // already past today: tomorrow
            ['morgen', d(2026, 11, 17)],
            ['Morgen 18 Uhr', d(2026, 11, 17, 18)],
            ['übermorgen 7:30', d(2026, 11, 18, 7, 30)],
            ['Sonntag', d(2026, 11, 22)],
            ['Sonntag 18 Uhr', d(2026, 11, 22, 18)],
            ['Montag', d(2026, 11, 23)], // today is Monday: next week
            ['Montag 18:00', d(2026, 11, 16, 18)], // later today
            ['Fr 12:00', d(2026, 11, 20, 12)],
            ['Saturday 10:00', d(2026, 11, 21, 10)],
        ];
        for (const [text, at] of cases) {
            expect(parseReturnAt(text, NOW), text).to.deep.equal({ ok: true, at });
        }
        expect(parseSpokenDate('irgendwann', NOW)).to.equal(null);
        expect(parseSpokenDate('24.12. 25:00', NOW)).to.be.NaN;
        expect(parseSpokenDate('31.02.', NOW)).to.be.NaN;
        expect(parseReturnAt('heute', NOW).ok).to.equal(false); // 00:00 today is past
    });
});
