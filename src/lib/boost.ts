/**
 * Boost logic: raise the setpoint for a while, then restore the previous setpoint.
 * The device's own boost runs only 5 minutes, so the long boost lives in the adapter.
 */

/** Persisted boost of one thermostat */
export interface BoostState {
    /** End of the boost (ms since epoch) */
    until: number;
    /** Setpoint before the boost */
    previous: number;
    /** Setpoint during the boost */
    target: number;
}

/**
 * Starts a boost. Returns null when there is no known setpoint to come back to.
 *
 * @param now Current time
 * @param currentSetpoint Setpoint before the boost
 * @param minutes Duration
 * @param target Setpoint during the boost
 */
export function startBoost(
    now: number,
    currentSetpoint: number | null,
    minutes: number,
    target: number,
): BoostState | null {
    if (currentSetpoint === null || !Number.isFinite(currentSetpoint)) {
        return null;
    }
    return { until: now + minutes * 60_000, previous: currentSetpoint, target };
}

/**
 * Decides what a setpoint reported by the device means for a running boost.
 * A value other than the boost target means someone changed it by hand: the boost ends without restore.
 *
 * @param boost Running boost
 * @param reportedSetpoint Setpoint reported by the device
 */
export function boostAfterReport(boost: BoostState, reportedSetpoint: number): 'keep' | 'cancel' {
    return Math.abs(reportedSetpoint - boost.target) < 0.01 ? 'keep' : 'cancel';
}

/**
 * Remaining time of a boost in ms (0 when it is due).
 *
 * @param boost Running boost
 * @param now Current time
 */
export function boostRemaining(boost: BoostState, now: number): number {
    return Math.max(0, boost.until - now);
}

/**
 * Restores a boost from its persisted JSON. Invalid content gives null.
 *
 * @param json Stored value
 */
export function parseBoost(json: unknown): BoostState | null {
    if (typeof json !== 'string' || json === '') {
        return null;
    }
    try {
        const b = JSON.parse(json) as Partial<BoostState>;
        if (
            typeof b.until === 'number' &&
            typeof b.previous === 'number' &&
            typeof b.target === 'number' &&
            Number.isFinite(b.until + b.previous + b.target)
        ) {
            return { until: b.until, previous: b.previous, target: b.target };
        }
    } catch {
        // fall through
    }
    return null;
}
