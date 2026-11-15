/**
 * Sequence numbers must never repeat for the own address (the mesh drops replays).
 * They are reserved in blocks: the persisted value is always ahead of every number handed out,
 * so a crash only skips numbers and never reuses one.
 */

export const SEQ_BLOCK = 256;
export const SEQ_LIMIT = 0xffffff;

/** Hands out sequence numbers and asks for persistence before a new block is used */
export class SeqAllocator {
    private next: number;
    private reservedUpTo: number;

    /**
     * @param persistedReserve Value stored by the last run (0 for a fresh start)
     * @param persist Stores a new reserve; called synchronously before numbers of the block are used
     */
    public constructor(
        persistedReserve: number,
        private readonly persist: (reserve: number) => void,
    ) {
        const start = Number.isInteger(persistedReserve) && persistedReserve > 0 ? persistedReserve : 0;
        this.next = start;
        this.reservedUpTo = start;
    }

    /** Next free number; throws when the 24-bit space is used up (needs an IV update) */
    public take(): number {
        if (this.next >= SEQ_LIMIT) {
            throw new Error('sequence numbers exhausted');
        }
        // extend early (half a block ahead), so the persisted value stays ahead even while it is being written
        if (this.next >= this.reservedUpTo - SEQ_BLOCK / 2) {
            this.reservedUpTo = Math.min(SEQ_LIMIT, Math.max(this.reservedUpTo, this.next) + SEQ_BLOCK);
            this.persist(this.reservedUpTo);
        }
        return this.next++;
    }

    /** The value that has to be persisted at minimum */
    public get reserve(): number {
        return this.reservedUpTo;
    }
}
