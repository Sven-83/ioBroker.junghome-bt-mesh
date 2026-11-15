/**
 * Bluetooth Mesh security toolbox (Mesh Protocol 1.1, section 3.9.2) on top of Node's crypto.
 */
import * as crypto from 'node:crypto';

/**
 * AES-128 in ECB mode on exactly one 16-byte block.
 *
 * @param key 16-byte key
 * @param block 16-byte block
 */
export function aesEcb(key: Buffer, block: Buffer): Buffer {
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(block), cipher.final()]);
}

function shiftLeft(block: Buffer): Buffer {
    const out = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
        out[i] = ((block[i] << 1) | (i < 15 ? block[i + 1] >> 7 : 0)) & 0xff;
    }
    return out;
}

/**
 * Byte-wise XOR of two buffers of the same length.
 *
 * @param a First buffer
 * @param b Second buffer
 */
export function xor(a: Buffer, b: Buffer): Buffer {
    const out = Buffer.alloc(a.length);
    for (let i = 0; i < a.length; i++) {
        out[i] = a[i] ^ b[i];
    }
    return out;
}

/**
 * AES-CMAC (RFC 4493).
 *
 * @param key 16-byte key
 * @param message Message of any length
 */
export function cmac(key: Buffer, message: Buffer): Buffer {
    const l = aesEcb(key, Buffer.alloc(16));
    const k1 = shiftLeft(l);
    if (l[0] & 0x80) {
        k1[15] ^= 0x87;
    }
    const k2 = shiftLeft(k1);
    if (k1[0] & 0x80) {
        k2[15] ^= 0x87;
    }
    const blocks = Math.max(1, Math.ceil(message.length / 16));
    const complete = message.length > 0 && message.length % 16 === 0;
    let last: Buffer;
    if (complete) {
        last = xor(message.subarray((blocks - 1) * 16), k1);
    } else {
        const padded = Buffer.alloc(16);
        message.subarray((blocks - 1) * 16).copy(padded);
        padded[message.length % 16] = 0x80;
        last = xor(padded, k2);
    }
    let x: Buffer = Buffer.alloc(16);
    for (let i = 0; i < blocks - 1; i++) {
        x = aesEcb(key, xor(x, message.subarray(i * 16, i * 16 + 16)));
    }
    return aesEcb(key, xor(x, last));
}

/**
 * Salt generation function s1.
 *
 * @param text ASCII text
 */
export function s1(text: string): Buffer {
    return cmac(Buffer.alloc(16), Buffer.from(text, 'ascii'));
}

/** Network keys derived with k2 */
export interface NetworkKeys {
    /** Network identifier (7 bit) */
    nid: number;
    /** Network encryption key */
    encryptionKey: Buffer;
    /** Network privacy key */
    privacyKey: Buffer;
}

/**
 * Network key material derivation function k2 (managed flooding: P = 0x00).
 *
 * @param n NetKey
 * @param p Parameter P
 */
export function k2(n: Buffer, p: Buffer): NetworkKeys {
    const t = cmac(s1('smk2'), n);
    const t1 = cmac(t, Buffer.concat([p, Buffer.from([0x01])]));
    const t2 = cmac(t, Buffer.concat([t1, p, Buffer.from([0x02])]));
    const t3 = cmac(t, Buffer.concat([t2, p, Buffer.from([0x03])]));
    return { nid: t1[15] & 0x7f, encryptionKey: t2, privacyKey: t3 };
}

/**
 * Application key identifier derivation function k4 (AID).
 *
 * @param n AppKey
 */
export function k4(n: Buffer): number {
    return cmac(cmac(s1('smk4'), n), Buffer.from('id6\x01', 'binary'))[15] & 0x3f;
}

/**
 * AES-CCM encryption.
 *
 * @param key 16-byte key
 * @param nonce 13-byte nonce
 * @param data Plain text
 * @param micLength MIC length in bytes (4 or 8)
 */
export function ccmEncrypt(key: Buffer, nonce: Buffer, data: Buffer, micLength: number): Buffer {
    const cipher = crypto.createCipheriv('aes-128-ccm', key, nonce, { authTagLength: micLength });
    const out = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([out, cipher.getAuthTag()]);
}

/**
 * AES-CCM decryption, returns null when the MIC does not match.
 *
 * @param key 16-byte key
 * @param nonce 13-byte nonce
 * @param dataWithMic Cipher text followed by the MIC
 * @param micLength MIC length in bytes (4 or 8)
 */
export function ccmDecrypt(key: Buffer, nonce: Buffer, dataWithMic: Buffer, micLength: number): Buffer | null {
    if (dataWithMic.length < micLength) {
        return null;
    }
    try {
        const decipher = crypto.createDecipheriv('aes-128-ccm', key, nonce, { authTagLength: micLength });
        decipher.setAuthTag(dataWithMic.subarray(dataWithMic.length - micLength));
        return Buffer.concat([
            decipher.update(dataWithMic.subarray(0, dataWithMic.length - micLength)),
            decipher.final(),
        ]);
    } catch {
        return null;
    }
}
