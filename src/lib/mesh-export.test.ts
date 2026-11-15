import { expect } from 'chai';
import { checkOwnAddress, parseMeshExport } from './mesh-export';
import { TEST_MAC, buildExport } from './test-export.test-helper';

describe('mesh-export', () => {
    it('finds the thermostat with its elements, MAC and name', () => {
        const { text, keys } = buildExport();
        const exp = parseMeshExport(text);
        expect(exp.netKey.toString('hex')).to.equal(keys.netKey);
        expect(exp.appKey.toString('hex')).to.equal(keys.appKey);
        expect(exp.thermostats).to.have.length(1);
        const t = exp.thermostats[0];
        expect(t).to.include({
            address: 6,
            levelAddress: 6,
            onOffAddress: 7,
            sensorAddress: 8,
            mac: TEST_MAC,
            name: 'Test room',
        });
        expect(exp.deviceKeys.get(6)?.toString('hex')).to.equal(keys.devKey);
        expect(exp.nodeRanges).to.deep.include([6, 8]);
    });

    it('rejects broken input without leaking key material', () => {
        expect(() => parseMeshExport('nope')).to.throw('not valid JSON');
        expect(() => parseMeshExport('{}')).to.throw('no "network" part');
        const { text } = buildExport({ netKey: 'abc' });
        expect(() => parseMeshExport(text)).to.throw('NetKey is missing or not 16 bytes');
    });

    it('checks the own address against devices and the app range', () => {
        const exp = parseMeshExport(buildExport().text);
        expect(checkOwnAddress(0x0d01, exp)).to.equal(null);
        expect(checkOwnAddress(0x0007, exp)).to.match(/belongs to a device/);
        expect(checkOwnAddress(0x0100, exp)).to.match(/range of the JUNG HOME app/);
        expect(checkOwnAddress(0x8000, exp)).to.match(/between 0001 and 7FFF/);
    });
});
