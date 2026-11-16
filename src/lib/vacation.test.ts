import { expect } from 'chai';
import {
    MAX_VACATION_DAYS,
    manualChangeText,
    parseReturnAt,
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
});
