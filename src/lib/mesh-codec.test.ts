import { expect } from 'chai';
import { MeshCodec, PROXY_TYPE_BEACON, PROXY_TYPE_NETWORK, decodeOpcode, encodeOpcode } from './mesh-codec';
import { cmac, s1 } from './mesh-crypto';
import { parseMeshExport } from './mesh-export';
import { buildExport } from './test-export.fixture.test';

function pair(): { a: MeshCodec; b: MeshCodec; seqA: () => number } {
    const exp = parseMeshExport(buildExport().text);
    let sa = 100;
    let sb = 500;
    const common = { netKey: exp.netKey, appKey: exp.appKey, deviceKeys: exp.deviceKeys, ivIndex: 0 };
    return {
        a: new MeshCodec({ ...common, ownAddress: 0x0d01, nextSeq: () => sa++ }),
        b: new MeshCodec({ ...common, ownAddress: 0x0006, nextSeq: () => sb++ }),
        seqA: () => sa,
    };
}

function beacon(netKey: Buffer, flags: number, ivIndex: number): Buffer {
    const t = cmac(s1('nkbk'), netKey);
    const beaconKey = cmac(t, Buffer.concat([Buffer.from('id128', 'ascii'), Buffer.from([0x01])]));
    const body = Buffer.alloc(13);
    body[0] = flags;
    body.writeUInt32BE(ivIndex, 9);
    const auth = cmac(beaconKey, body).subarray(0, 8);
    return Buffer.concat([Buffer.from([0x01]), body, auth]);
}

describe('mesh-codec', () => {
    it('encodes and decodes opcodes of all lengths', () => {
        for (const op of [0x52, 0x8205, 0xd12705]) {
            expect(decodeOpcode(Buffer.concat([encodeOpcode(op), Buffer.from([1, 2])]))).to.deep.equal({
                opcode: op,
                params: Buffer.from([1, 2]),
            });
        }
        expect(decodeOpcode(Buffer.from([0x7f]))).to.equal(null);
    });

    it('round-trips an access message between two nodes', () => {
        const { a, b } = pair();
        const pdu = a.encodeAccess(0x0006, 0x8206, Buffer.from([0x01, 0x02, 0x03]));
        const events = b.handle(PROXY_TYPE_NETWORK, pdu, 0);
        expect(events).to.deep.equal([
            { kind: 'access', message: { src: 0x0d01, dst: 0x0006, opcode: 0x8206, params: Buffer.from([1, 2, 3]) } },
        ]);
    });

    it('drops replays, own messages and foreign networks', () => {
        const { a, b } = pair();
        const pdu = a.encodeAccess(0x0006, 0x8205);
        expect(b.handle(PROXY_TYPE_NETWORK, pdu, 0)).to.have.length(1);
        expect(b.handle(PROXY_TYPE_NETWORK, pdu, 0)).to.have.length(0); // replay
        expect(a.handle(PROXY_TYPE_NETWORK, a.encodeAccess(0x0006, 0x8205), 0)).to.have.length(0); // own
        const other = pair();
        expect(b.handle(PROXY_TYPE_NETWORK, other.a.encodeAccess(0x0006, 0x8205), 0)).to.have.length(0);
    });

    it('rejects a tampered PDU', () => {
        const { a, b } = pair();
        const pdu = a.encodeAccess(0x0006, 0x8205);
        pdu[pdu.length - 1] ^= 0xff;
        expect(b.handle(PROXY_TYPE_NETWORK, pdu, 0)).to.have.length(0);
    });

    it('uses a new sequence number for every message', () => {
        const { a, seqA } = pair();
        a.encodeAccess(6, 0x8205);
        a.encodeAccess(6, 0x8205);
        expect(seqA()).to.equal(102);
    });

    it('accepts an authentic beacon and takes over its IV index', () => {
        const exp = parseMeshExport(buildExport().text);
        const c = new MeshCodec({
            netKey: exp.netKey,
            appKey: exp.appKey,
            deviceKeys: exp.deviceKeys,
            ownAddress: 0x0d01,
            ivIndex: 0,
            nextSeq: () => 1,
        });
        expect(c.handle(PROXY_TYPE_BEACON, beacon(exp.netKey, 0, 3), 0)).to.deep.equal([
            { kind: 'beacon', ivIndex: 3, ivUpdate: false },
        ]);
        expect(c.ivIndex).to.equal(3);
        const forged = beacon(exp.netKey, 0, 9);
        forged[21] ^= 1;
        expect(c.handle(PROXY_TYPE_BEACON, forged, 0)).to.have.length(0);
        expect(c.ivIndex).to.equal(3);
    });

    it('refuses access messages that do not fit into one PDU', () => {
        const { a } = pair();
        expect(() => a.encodeAccess(6, 0x8206, Buffer.alloc(10))).to.throw('too long');
    });
});
