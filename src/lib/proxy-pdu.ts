/**
 * Proxy PDU segmentation and reassembly (Mesh Protocol 1.1, 6.3.1, SAR field).
 */

const SAR_COMPLETE = 0;
const SAR_FIRST = 1;
const SAR_CONTINUATION = 2;
const SAR_LAST = 3;

/**
 * Splits a PDU into proxy PDUs that fit into one GATT write.
 *
 * @param type Proxy message type (0 network, 1 beacon, 2 proxy configuration)
 * @param pdu Complete PDU
 * @param mtu ATT MTU of the connection
 */
export function segmentProxyPdu(type: number, pdu: Buffer, mtu: number): Buffer[] {
    const chunk = Math.max(19, (mtu || 23) - 4); // 3 bytes ATT header + 1 byte proxy header
    if (pdu.length <= chunk) {
        return [Buffer.concat([Buffer.from([(SAR_COMPLETE << 6) | type]), pdu])];
    }
    const out: Buffer[] = [];
    for (let i = 0; i < pdu.length; i += chunk) {
        const sar = i === 0 ? SAR_FIRST : i + chunk >= pdu.length ? SAR_LAST : SAR_CONTINUATION;
        out.push(Buffer.concat([Buffer.from([(sar << 6) | type]), pdu.subarray(i, i + chunk)]));
    }
    return out;
}

/** Reassembles proxy PDUs received as GATT notifications */
export class ProxyReassembler {
    private buffer: Buffer | null = null;
    private type = -1;

    /**
     * Adds one notification and returns the complete PDU when it is finished.
     *
     * @param data One GATT notification
     */
    public push(data: Buffer): { type: number; pdu: Buffer } | null {
        if (data.length < 1) {
            return null;
        }
        const sar = data[0] >> 6;
        const type = data[0] & 0x3f;
        const payload = data.subarray(1);
        switch (sar) {
            case SAR_COMPLETE:
                this.buffer = null;
                return { type, pdu: Buffer.from(payload) };
            case SAR_FIRST:
                this.buffer = Buffer.from(payload);
                this.type = type;
                return null;
            case SAR_CONTINUATION:
                if (!this.buffer || type !== this.type) {
                    this.buffer = null;
                    return null;
                }
                this.buffer = Buffer.concat([this.buffer, payload]);
                return null;
            default: {
                if (!this.buffer || type !== this.type) {
                    this.buffer = null;
                    return null;
                }
                const pdu = Buffer.concat([this.buffer, payload]);
                this.buffer = null;
                return { type, pdu };
            }
        }
    }

    /** Drops a half received PDU (e.g. after a reconnect) */
    public reset(): void {
        this.buffer = null;
    }
}
