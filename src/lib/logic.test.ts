import { expect } from 'chai';
import { boostAfterReport, boostRemaining, parseBoost, startBoost } from './boost';
import { temperatureColor } from './color';
import { checkConfig } from './config';
import { backoffDelay, uuid16 } from './mesh-link';
import { ProxyReassembler, segmentProxyPdu } from './proxy-pdu';
import { SEQ_BLOCK, SeqAllocator } from './seq';
import {
    OP_GENERIC_LEVEL_STATUS,
    OP_GENERIC_ONOFF_STATUS,
    OP_JUNG_ADMIN_STATUS,
    OP_SENSOR_STATUS,
    celsiusToLevel,
    interpret,
    levelSetParams,
    levelToCelsius,
    validateSetpoint,
} from './thermostat';
import type { ThermostatInfo } from './mesh-export';
import { TEST_MAC } from './test-export.test-helper';

const T: ThermostatInfo = {
    address: 6,
    name: 'x',
    mac: TEST_MAC,
    levelAddress: 6,
    onOffAddress: 7,
    sensorAddress: 8,
};

describe('thermostat', () => {
    it('converts setpoints like the device (verified 20.0 / 20.5 / 22.5 °C)', () => {
        expect(celsiusToLevel(20.5)).to.equal(Math.round(0.62 * 65535) - 32768);
        for (const c of [5, 20, 20.5, 22.5, 30]) {
            expect(levelToCelsius(celsiusToLevel(c))).to.equal(c);
        }
        expect(levelToCelsius(13106)).to.equal(22.5); // value seen on hardware
    });

    it('validates and rounds requested setpoints', () => {
        expect(validateSetpoint(21.3)).to.deep.equal({ ok: true, celsius: 21.5 });
        expect(validateSetpoint('20')).to.deep.equal({ ok: true, celsius: 20 });
        expect(validateSetpoint(31).ok).to.equal(false);
        expect(validateSetpoint('warm').ok).to.equal(false);
        expect(validateSetpoint(null).ok).to.equal(false);
    });

    it('builds a Generic Level Set with TID', () => {
        const p = levelSetParams(20, 0x1ff);
        expect(p.readInt16LE(0)).to.equal(celsiusToLevel(20));
        expect(p[2]).to.equal(0xff);
    });

    it('interprets status messages of the right elements only', () => {
        const lvl = Buffer.alloc(2);
        lvl.writeInt16LE(13106);
        expect(interpret({ src: 6, dst: 0xc005, opcode: OP_GENERIC_LEVEL_STATUS, params: lvl }, [T])).to.deep.equal([
            { address: 6, field: 'setpoint', value: 22.5 },
        ]);
        expect(interpret({ src: 8, dst: 1, opcode: OP_GENERIC_LEVEL_STATUS, params: lvl }, [T])).to.deep.equal([]);
        expect(
            interpret({ src: 7, dst: 1, opcode: OP_GENERIC_ONOFF_STATUS, params: Buffer.from([1]) }, [T]),
        ).to.deep.equal([{ address: 6, field: 'heating', value: true }]);
        // Sensor Status, format A: property 0x004F, length 1 → MPID = (0x4F << 5) | (0 << 1) | 0
        const mpid = Buffer.alloc(2);
        mpid.writeUInt16LE(0x4f << 5);
        expect(
            interpret({ src: 8, dst: 1, opcode: OP_SENSOR_STATUS, params: Buffer.concat([mpid, Buffer.from([45])]) }, [
                T,
            ]),
        ).to.deep.equal([{ address: 6, field: 'temperature', value: 22.5 }]);
        expect(
            interpret(
                { src: 8, dst: 1, opcode: OP_SENSOR_STATUS, params: Buffer.concat([mpid, Buffer.from([0x7f])]) },
                [T],
            ),
        ).to.deep.equal([]);
        expect(
            interpret({ src: 6, dst: 1, opcode: OP_JUNG_ADMIN_STATUS, params: Buffer.from([0x0b, 0x12, 0x03, 0x01]) }, [
                T,
            ]),
        ).to.deep.equal([{ address: 6, field: 'mode', value: 1 }]);
        expect(
            interpret({ src: 0x99, dst: 1, opcode: OP_GENERIC_ONOFF_STATUS, params: Buffer.from([1]) }, [T]),
        ).to.deep.equal([]);
    });
});

describe('boost', () => {
    it('starts, keeps on its own report, cancels on a manual change', () => {
        const b = startBoost(1000, 20, 60, 30)!;
        expect(b).to.deep.equal({ until: 1000 + 3_600_000, previous: 20, target: 30 });
        expect(boostAfterReport(b, 30)).to.equal('keep');
        expect(boostAfterReport(b, 21)).to.equal('cancel');
        expect(boostRemaining(b, 1000 + 3_600_000 + 5)).to.equal(0);
        expect(startBoost(0, null, 60, 30)).to.equal(null);
    });

    it('survives a restart through its JSON', () => {
        const b = startBoost(5, 19.5, 30, 28)!;
        expect(parseBoost(JSON.stringify(b))).to.deep.equal(b);
        expect(parseBoost('')).to.equal(null);
        expect(parseBoost('{"until":1}')).to.equal(null);
        expect(parseBoost('{bad')).to.equal(null);
    });
});

describe('color', () => {
    it('goes from blue over neutral to orange', () => {
        expect(temperatureColor(15)).to.equal('#3b82f6');
        expect(temperatureColor(21)).to.equal('#e5e7eb');
        expect(temperatureColor(30)).to.equal('#f97316');
        expect(temperatureColor(19.5)).to.match(/^#[0-9a-f]{6}$/);
        expect(temperatureColor(null)).to.equal('');
    });
});

describe('seq', () => {
    it('never hands out a number at or above the persisted reserve', () => {
        const persisted: number[] = [];
        const s = new SeqAllocator(1000, r => persisted.push(r));
        for (let i = 0; i < 3 * SEQ_BLOCK; i++) {
            const n = s.take();
            expect(n).to.equal(1000 + i);
            expect(n).to.be.lessThan(persisted[persisted.length - 1]);
        }
        // after a "crash" the new run starts at the last persisted value → no reuse
        const restart = new SeqAllocator(persisted[persisted.length - 1], () => undefined);
        expect(restart.take()).to.be.greaterThan(1000 + 3 * SEQ_BLOCK - 1);
    });
});

describe('proxy-pdu', () => {
    it('segments and reassembles long PDUs', () => {
        const pdu = Buffer.from(Array.from({ length: 50 }, (_, i) => i));
        const parts = segmentProxyPdu(0, pdu, 23);
        expect(parts.length).to.equal(3);
        const r = new ProxyReassembler();
        expect(r.push(parts[0])).to.equal(null);
        expect(r.push(parts[1])).to.equal(null);
        expect(r.push(parts[2])).to.deep.equal({ type: 0, pdu });
        expect(segmentProxyPdu(2, Buffer.alloc(10), 247)).to.have.length(1);
    });

    it('drops a continuation without start', () => {
        const r = new ProxyReassembler();
        expect(r.push(Buffer.from([0xc0, 1, 2]))).to.equal(null);
        expect(r.push(Buffer.from([0x01, 9]))).to.deep.equal({ type: 1, pdu: Buffer.from([9]) });
    });
});

describe('mesh-link helpers', () => {
    it('reads 16-bit UUIDs from all API encodings', () => {
        expect(uuid16({ shortUuid: 0x1828 })).to.equal(0x1828);
        expect(uuid16({ uuid: '00002add-0000-1000-8000-00805f9b34fb' })).to.equal(0x2add);
        expect(uuid16({ uuidList: [String(0x00002ade00001000n), '0'] })).to.equal(0x2ade);
        expect(uuid16({})).to.equal(-1);
    });

    it('backs off exponentially up to 5 minutes', () => {
        expect([1, 2, 3, 10].map(backoffDelay)).to.deep.equal([5000, 10000, 20000, 300000]);
    });
});

describe('config', () => {
    const base = {
        meshExport: '{}',
        ownAddress: '0D01',
        proxy1Host: '192.0.2.10', // RFC 5737 documentation address
        proxy1Key: Buffer.alloc(32, 7).toString('base64'),
        proxy2Host: '',
        proxy2Key: '',
        pollMinutes: 5,
        boostMinutes: 60,
        boostSetpoint: 30,
    };

    it('accepts a valid configuration', () => {
        const r = checkConfig(base);
        expect(r.errors).to.deep.equal([]);
        expect(r.config.ownAddress).to.equal(0x0d01);
        expect(r.config.proxies).to.have.length(1);
        expect(r.config.pollMs).to.equal(300_000);
    });

    it('reports bad values without echoing the key', () => {
        const r = checkConfig({ ...base, ownAddress: 'x', proxy1Key: 'secret-but-wrong', meshExport: '' });
        expect(r.errors.join('|'))
            .to.match(/own address/)
            .and.match(/encryption key/)
            .and.match(/export is missing/);
        expect(r.errors.join('|')).not.to.include('secret-but-wrong');
    });
});
