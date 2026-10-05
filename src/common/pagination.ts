/** Keyset cursor = base64url({ k: sortKey, id }). Never OFFSET (spec §5.1). */
export const encodeCursor = (k: string | number, id: string) => Buffer.from(JSON.stringify({ k, id })).toString('base64url');
export function decodeCursor(c?: string): { k: string | number; id: string } | null {
  if (!c) return null;
  try { return JSON.parse(Buffer.from(c, 'base64url').toString()); } catch { return null; }
}
export const clampLimit = (n: unknown, def = 20) => Math.min(100, Math.max(1, Number(n) || def));
