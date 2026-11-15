import { expect } from 'chai';
import { ccmDecrypt, ccmEncrypt, cmac, k2, k4, s1 } from './mesh-crypto';

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s/g, ''), 'hex');

describe('mesh-crypto', () => {
    it('cmac matches RFC 4493 example 2', () => {
        const key = hex('2b7e151628aed2a6abf7158809cf4f3c');
        expect(cmac(key, hex('6bc1bee22e409f96e93d7e117393172a')).toString('hex')).to.equal(
            '070a16b46b4d4144f79bdd9dd04a287c',
        );
    });

    it('cmac matches RFC 4493 example 1 (empty message)', () => {
        const key = hex('2b7e151628aed2a6abf7158809cf4f3c');
        expect(cmac(key, Buffer.alloc(0)).toString('hex')).to.equal('bb1d6929e95937287fa37d129b756746');
    });

    it('s1 matches the Mesh sample data', () => {
        expect(s1('test').toString('hex')).to.equal('b73cefbd641ef2ea598c2b6efb62f79c');
    });

    it('k2 matches the Mesh sample data (master credentials)', () => {
        const keys = k2(hex('f7a2a44f8e8a8029064f173ddc1e2b00'), Buffer.from([0x00]));
        expect(keys.nid).to.equal(0x7f);
        expect(keys.encryptionKey.toString('hex')).to.equal('9f589181a0f50de73c8070c7a6d27f46');
        expect(keys.privacyKey.toString('hex')).to.equal('4c715bd4a64b938f99b453351653124f');
    });

    it('k4 matches the Mesh sample data', () => {
        expect(k4(hex('3216d1509884b533248541792b877f98'))).to.equal(0x38);
    });

    it('ccm round trip works and a wrong MIC is rejected', () => {
        const key = hex('000102030405060708090a0b0c0d0e0f');
        const nonce = hex('00010203040506070809 0a0b0c');
        const enc = ccmEncrypt(key, nonce, Buffer.from('hello mesh'), 4);
        expect(ccmDecrypt(key, nonce, enc, 4)?.toString()).to.equal('hello mesh');
        enc[enc.length - 1] ^= 1;
        expect(ccmDecrypt(key, nonce, enc, 4)).to.equal(null);
        expect(ccmDecrypt(key, nonce, Buffer.alloc(2), 4)).to.equal(null);
    });
});
