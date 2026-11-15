/**
 * Room colour for the floor plan: cold = blue, comfortable = neutral, warm = orange.
 */

const STOPS: Array<[number, [number, number, number]]> = [
    [18, [0x3b, 0x82, 0xf6]], // blue
    [21, [0xe5, 0xe7, 0xeb]], // neutral
    [24, [0xf9, 0x73, 0x16]], // orange
];

const hex2 = (n: number): string => Math.round(n).toString(16).padStart(2, '0');

/**
 * Colour for a room temperature as #rrggbb, or an empty string when the temperature is unknown.
 *
 * @param celsius Room temperature
 */
export function temperatureColor(celsius: number | null): string {
    if (celsius === null || !Number.isFinite(celsius)) {
        return '';
    }
    if (celsius <= STOPS[0][0]) {
        return `#${STOPS[0][1].map(hex2).join('')}`;
    }
    for (let i = 1; i < STOPS.length; i++) {
        const [t1, c1] = STOPS[i];
        if (celsius <= t1) {
            const [t0, c0] = STOPS[i - 1];
            const f = (celsius - t0) / (t1 - t0);
            return `#${c0.map((v, k) => hex2(v + (c1[k] - v) * f)).join('')}`;
        }
    }
    return `#${STOPS[STOPS.length - 1][1].map(hex2).join('')}`;
}
