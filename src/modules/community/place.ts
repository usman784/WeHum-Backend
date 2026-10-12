import { countryName } from '../../common/belts';

/** "Europe/London" → "London", "America/New_York" → "New York", "UTC" → null. Coarse by design: the time zone is the only source. */
export function cityFromTimezone(tz: string | null | undefined): string | null {
  if (!tz || !tz.includes('/')) return null;
  const last = tz.split('/').at(-1)!.replace(/_/g, ' ');
  return /^[A-Za-z .'-]{2,40}$/.test(last) ? last : null;
}

/** "London, UK" style label, or null when the person keeps the place private. */
export function placeLabel(tz: string | null | undefined, country: string | null | undefined): string | null {
  const city = cityFromTimezone(tz);
  const c = country ? countryName(country) : null;
  if (city && c) return `${city}, ${c}`;
  return city ?? c;
}
