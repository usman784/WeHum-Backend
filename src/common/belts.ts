import { regionOf } from '../realtime/regions';

/** The three belts the Stitch designs show next to the live count. Only ISO country codes are ever mapped (no coordinates). */
export const BELTS = ['americas', 'emea', 'apac'] as const;
export type Belt = (typeof BELTS)[number];
export const BELT_NAMES: Record<Belt, string> = { americas: 'Americas', emea: 'EMEA', apac: 'APAC' };

const OF_REGION: Record<string, Belt> = {
  'North America': 'americas', 'South America': 'americas', Europe: 'emea', 'Middle East': 'emea', Africa: 'emea', Asia: 'apac', Oceania: 'apac',
};

export const beltOf = (country: string): Belt | null => OF_REGION[regionOf(country)] ?? null;

export type BeltCounts = Record<Belt, number>;
export const emptyBelts = (): BeltCounts => ({ americas: 0, emea: 0, apac: 0 });

/** Sums `{ c, n }` country counts into belts (unknown and hidden countries are not in any belt). */
export function beltsOf(list: { c: string; n: number }[]): BeltCounts {
  const out = emptyBelts();
  for (const e of list) { const b = beltOf(e.c); if (b) out[b] += e.n; }
  return out;
}

let names: Intl.DisplayNames | null = null;
/** "GB" → "United Kingdom" (falls back to the code). */
export function countryName(code: string): string {
  try { names ??= new Intl.DisplayNames(['en'], { type: 'region' }); return names.of(code) ?? code; } catch { return code; }
}
