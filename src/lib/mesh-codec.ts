/**
 * Bluetooth Mesh network, transport and access layer for a GATT proxy client.
 * Only what a room thermostat needs: unsegmented access messages out,
 * segmented and unsegmented access messages in, proxy configuration, secure network beacons.
 */
import { aesEcb, ccmDecrypt, ccmEncrypt, cmac, k2, k4, s1, xor, type NetworkKeys } from './mesh-crypto';

/** Proxy PDU message types (Mesh Protocol 1.1, 6.3.1) */
export const PROXY_TYPE_NETWORK = 0x00;
export const PROXY_TYPE_BEACON = 0x01;
export const PROXY_TYPE_CONFIG = 0x02;

/** A decoded access message */
export interface AccessMessage {
    /** Source address */
    src: number;
    /** Destination address */
    dst: number;
    /** Access opcode */
    opcode: number;
    /** Opcode parameters */
    params: Buffer;
}

/** Result of handling one complete proxy PDU */
export type MeshEvent =
    | { kind: 'access'; message: AccessMessage }
    | { kind: 'beacon'; ivIndex: number; ivUpdate: boolean }
    | { kind: 'filterStatus'; acceptList: boolean; count: number };

/** Keys and settings for the codec */
export interface CodecOptions {
    /** Network key */
    netKey: Buffer;
    /** Application key */
    appKey: Buffer;
    /** Device keys by primary unicast address */
    deviceKeys: Map<number, Buffer>;
    /** Own unicast address */
    ownAddress: number;
    /** IV index */
    ivIndex: number;
    /** Time to live for sent messages (default 5) */
    ttl?: number;
    /** Returns the next sequence number (must be persisted by the caller) */
    nextSeq: () => number;
}

const u16 = (n: number): Buffer => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u24 = (n: number): Buffer => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
};

const SEGMENT_TIMEOUT_MS = 10_000;
const MAX_SEQ = 0xffffff;

/**
 * Encodes an access opcode (1, 2 or 3 bytes).
 *
 * @param opcode Opcode value as written in the spec, e.g. 0x8205 or 0xd12705
 */
export function encodeOpcode(opcode: number): Buffer {
    if (opcode <= 0x7e) {
        return Buffer.from([opcode]);
    }
    if (opcode <= 0xffff) {
        return u16(opcode);
    }
    return u24(opcode);
}

/**
 * Splits an access payload into opcode and parameters.
 *
 * @param access Decrypted access payload
 */
export function decodeOpcode(access: Buffer): { opcode: number; params: Buffer } | null {
    if (access.length === 0 || access[0] === 0x7f) {
        return null;
    }
    if ((access[0] & 0x80) === 0) {
        return { opcode: access[0], params: access.subarray(1) };
    }
    if ((access[0] & 0xc0) === 0x80) {
        return access.length < 2 ? null : { opcode: access.readUInt16BE(0), params: access.subarray(2) };
    }
    return access.length < 3 ? null : { opcode: access.readUIntBE(0, 3), params: access.subarray(3) };
}

interface PendingSegments {
    parts: Buffer[];
    segN: number;
    started: number;
}

/** Mesh codec: one instance per mesh network */
export class MeshCodec {
    private readonly keys: NetworkKeys;
    private readonly aid: number;
    private readonly ttl: number;
    private ivIndexValue: number;
    private ivUpdate = false;
    private readonly replay = new Map<number, { iv: number; seq: number }>();
    private readonly segments = new Map<string, PendingSegments>();

    /** @param options Keys and settings */
    public constructor(private readonly options: CodecOptions) {
        this.keys = k2(options.netKey, Buffer.from([0x00]));
        this.aid = k4(options.appKey);
        this.ttl = options.ttl ?? 5;
        this.ivIndexValue = options.ivIndex >>> 0;
    }

    /** Current IV index of the network */
    public get ivIndex(): number {
        return this.ivIndexValue;
    }

    /** IV index used for sending (one lower while an IV update is in progress) */
    private get txIvIndex(): number {
        return this.ivUpdate && this.ivIndexValue > 0 ? this.ivIndexValue - 1 : this.ivIndexValue;
    }

    /**
     * Builds a network PDU carrying an unsegmented access message encrypted with the AppKey.
     *
     * @param dst Destination address
     * @param opcode Access opcode
     * @param params Opcode parameters
     */
    public encodeAccess(dst: number, opcode: number, params: Buffer = Buffer.alloc(0)): Buffer {
        const access = Buffer.concat([encodeOpcode(opcode), params]);
        if (access.length > 11) {
            throw new Error('access message too long for an unsegmented PDU');
        }
        const seq = this.takeSeq();
        const iv = this.txIvIndex;
        const appNonce = Buffer.concat([
            Buffer.from([0x01, 0x00]),
            u24(seq),
            u16(this.options.ownAddress),
            u16(dst),
            u32(iv),
        ]);
        const upper = ccmEncrypt(this.options.appKey, appNonce, access, 4);
        const lower = Buffer.concat([Buffer.from([0x40 | this.aid]), upper]);
        return this.encodeNetwork(0, this.ttl, dst, lower, seq, iv, false);
    }

    /**
     * Builds a proxy configuration message that switches the proxy filter to a reject list
     * (empty reject list = receive everything).
     */
    public encodeFilterAcceptAll(): Buffer {
        const seq = this.takeSeq();
        return this.encodeNetwork(1, 0, 0x0000, Buffer.from([0x00, 0x01]), seq, this.txIvIndex, true);
    }

    /**
     * Handles one complete (reassembled) proxy PDU.
     *
     * @param type Proxy PDU message type
     * @param data PDU without the proxy header
     * @param now Current time in ms (segment timeout)
     */
    public handle(type: number, data: Buffer, now: number): MeshEvent[] {
        if (type === PROXY_TYPE_BEACON) {
            return this.handleBeacon(data);
        }
        if (type !== PROXY_TYPE_NETWORK && type !== PROXY_TYPE_CONFIG) {
            return [];
        }
        const net = this.decodeNetwork(data, type === PROXY_TYPE_CONFIG);
        if (!net) {
            return [];
        }
        if (type === PROXY_TYPE_CONFIG) {
            // Filter Status: opcode 0x03, filter type, list size (2 bytes)
            if (net.transport[0] === 0x03 && net.transport.length >= 4) {
                return [
                    {
                        kind: 'filterStatus',
                        acceptList: net.transport[1] === 0x00,
                        count: net.transport.readUInt16BE(2),
                    },
                ];
            }
            return [];
        }
        if (net.ctl) {
            return []; // control messages (e.g. segment acks, heartbeats) are not needed
        }
        if (!this.acceptReplay(net.src, net.seq, net.iv)) {
            return [];
        }
        const message = this.decodeLowerTransport(net, now);
        return message ? [{ kind: 'access', message }] : [];
    }

    private takeSeq(): number {
        const seq = this.options.nextSeq();
        if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) {
            throw new Error('sequence number exhausted');
        }
        return seq;
    }

    private handleBeacon(data: Buffer): MeshEvent[] {
        // Secure Network Beacon: type 0x01, flags, network id (8), IV index (4), auth (8)
        if (data.length < 22 || data[0] !== 0x01) {
            return [];
        }
        const ivIndex = data.readUInt32BE(10);
        const ivUpdate = (data[1] & 0x02) !== 0;
        // Only accept the IV index from a beacon whose authentication value proves the NetKey
        if (!this.beaconAuthentic(data)) {
            return [];
        }
        if (ivIndex >= this.ivIndexValue && ivIndex - this.ivIndexValue <= 42) {
            if (ivIndex !== this.ivIndexValue) {
                this.replay.clear();
            }
            this.ivIndexValue = ivIndex;
            this.ivUpdate = ivUpdate;
        }
        return [{ kind: 'beacon', ivIndex, ivUpdate }];
    }

    private beaconAuthentic(data: Buffer): boolean {
        // BeaconKey = k1(NetKey, s1("nkbk"), "id128" || 0x01) (Mesh 3.9.6.3.4)
        const salt = s1('nkbk');
        const t = cmac(salt, this.options.netKey);
        const beaconKey = cmac(t, Buffer.concat([Buffer.from('id128', 'ascii'), Buffer.from([0x01])]));
        const auth = cmac(beaconKey, data.subarray(1, 14)).subarray(0, 8);
        return auth.equals(data.subarray(14, 22));
    }

    private encodeNetwork(
        ctl: number,
        ttl: number,
        dst: number,
        transport: Buffer,
        seq: number,
        iv: number,
        proxyNonce: boolean,
    ): Buffer {
        const ctlTtl = (ctl << 7) | (ttl & 0x7f);
        const nonce = Buffer.concat([
            Buffer.from([proxyNonce ? 0x03 : 0x00, proxyNonce ? 0x00 : ctlTtl]),
            u24(seq),
            u16(this.options.ownAddress),
            Buffer.from([0x00, 0x00]),
            u32(iv),
        ]);
        const encrypted = ccmEncrypt(this.keys.encryptionKey, nonce, Buffer.concat([u16(dst), transport]), ctl ? 8 : 4);
        const pecb = aesEcb(this.keys.privacyKey, Buffer.concat([Buffer.alloc(5), u32(iv), encrypted.subarray(0, 7)]));
        const header = xor(
            Buffer.concat([Buffer.from([ctlTtl]), u24(seq), u16(this.options.ownAddress)]),
            pecb.subarray(0, 6),
        );
        return Buffer.concat([Buffer.from([((iv & 1) << 7) | this.keys.nid]), header, encrypted]);
    }

    private decodeNetwork(
        pdu: Buffer,
        proxyNonce: boolean,
    ): { ctl: number; ttl: number; seq: number; src: number; dst: number; iv: number; transport: Buffer } | null {
        if (pdu.length < 14 || (pdu[0] & 0x7f) !== this.keys.nid) {
            return null;
        }
        const ivi = pdu[0] >> 7;
        const iv = (this.ivIndexValue & 1) === ivi ? this.ivIndexValue : this.ivIndexValue - 1;
        if (iv < 0) {
            return null;
        }
        const pecb = aesEcb(this.keys.privacyKey, Buffer.concat([Buffer.alloc(5), u32(iv), pdu.subarray(7, 14)]));
        const header = xor(pdu.subarray(1, 7), pecb.subarray(0, 6));
        const ctl = header[0] >> 7;
        const ttl = header[0] & 0x7f;
        const seq = header.readUIntBE(1, 3);
        const src = header.readUInt16BE(4);
        const micLength = ctl ? 8 : 4;
        const nonce = Buffer.concat([
            Buffer.from([proxyNonce ? 0x03 : 0x00, proxyNonce ? 0x00 : header[0]]),
            u24(seq),
            u16(src),
            Buffer.from([0x00, 0x00]),
            u32(iv),
        ]);
        const plain = ccmDecrypt(this.keys.encryptionKey, nonce, pdu.subarray(7), micLength);
        if (!plain || plain.length < 3) {
            return null;
        }
        return { ctl, ttl, seq, src, dst: plain.readUInt16BE(0), iv, transport: plain.subarray(2) };
    }

    private acceptReplay(src: number, seq: number, iv: number): boolean {
        if (src === this.options.ownAddress) {
            return false;
        }
        const last = this.replay.get(src);
        if (last && (iv < last.iv || (iv === last.iv && seq <= last.seq))) {
            return false;
        }
        this.replay.set(src, { iv, seq });
        return true;
    }

    private decodeLowerTransport(
        net: { seq: number; src: number; dst: number; iv: number; transport: Buffer },
        now: number,
    ): AccessMessage | null {
        const t = net.transport;
        const segmented = t[0] >> 7;
        const akf = (t[0] >> 6) & 1;
        const aid = t[0] & 0x3f;
        let upper: Buffer;
        let szmic = 0;
        let seqAuth = net.seq;
        if (!segmented) {
            upper = t.subarray(1);
        } else {
            if (t.length < 5) {
                return null;
            }
            szmic = t[1] >> 7;
            const seqZero = ((t[1] & 0x7f) << 6) | (t[2] >> 2);
            const segO = ((t[2] & 0x03) << 3) | (t[3] >> 5);
            const segN = t[3] & 0x1f;
            if (segO > segN) {
                return null;
            }
            seqAuth = (net.seq & ~0x1fff) | seqZero;
            if (seqAuth > net.seq) {
                seqAuth -= 0x2000;
            }
            this.dropStaleSegments(now);
            const id = `${net.src}:${seqZero}`;
            const entry = this.segments.get(id) ?? { parts: [], segN, started: now };
            entry.parts[segO] = t.subarray(4);
            this.segments.set(id, entry);
            for (let i = 0; i <= entry.segN; i++) {
                if (!entry.parts[i]) {
                    return null;
                }
            }
            this.segments.delete(id);
            upper = Buffer.concat(entry.parts);
        }
        let key: Buffer | undefined;
        if (akf) {
            key = aid === this.aid ? this.options.appKey : undefined;
        } else {
            key = this.options.deviceKeys.get(net.src);
        }
        if (!key) {
            return null;
        }
        const nonce = Buffer.concat([
            Buffer.from([akf ? 0x01 : 0x02, szmic << 7]),
            u24(seqAuth),
            u16(net.src),
            u16(net.dst),
            u32(net.iv),
        ]);
        const access = ccmDecrypt(key, nonce, upper, szmic ? 8 : 4);
        if (!access) {
            return null;
        }
        const op = decodeOpcode(access);
        return op ? { src: net.src, dst: net.dst, opcode: op.opcode, params: op.params } : null;
    }

    private dropStaleSegments(now: number): void {
        for (const [id, entry] of this.segments) {
            if (now - entry.started > SEGMENT_TIMEOUT_MS) {
                this.segments.delete(id);
            }
        }
    }
}
