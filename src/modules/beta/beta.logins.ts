import { passwordPolicy } from '../../common/password-policy';

/** 2–14 lowercase letters/digits starting with a letter: with the number it stays inside the 20-character username limit. */
export const PREFIX_RE = /^[a-z][a-z0-9]{1,13}$/;
export const LOGIN_RE = /^[a-z][a-z0-9]{2,19}$/;
const PASSWORD_SUFFIX = 'we';

/** Public mail providers: generated logins are mail aliases, so they must never point at someone else's inbox. */
const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com']);

/** beta + 7 at width 3 → beta007 (leading zeroes kept; the width grows only when the number needs it). */
export const loginFor = (prefix: string, n: number, width = 3) => `${prefix}${String(n).padStart(width, '0')}`;

/**
 * The requested initial password for a generated test account: the complete unique login plus "we"
 * (beta001 → beta001we). Lowercase and leading zeroes are kept exactly. Used for generated and imported test accounts only,
 * never for member sign-up or member password resets.
 */
export const initialPassword = (login: string) => `${login}${PASSWORD_SUFFIX}`;

/** The unchanged member password policy, applied to the generated value. */
export const passwordOk = (login: string) => passwordPolicy.safeParse(initialPassword(login)).success;

export function cleanDomain(raw: string): string | null {
  const d = raw.trim().toLowerCase().replace(/^@/, '');
  if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(d)) return null;
  return PUBLIC_DOMAINS.has(d) ? null : d;
}

/** Minimal RFC 4180 reader: quoted cells, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

export const IMPORT_TEMPLATE = 'login,display_name,access,premium_days\nbeta201,Sample Tester,free,\nbeta202,,premium,30\n';

export interface ImportRow { line: number; login: string; displayName: string | null; premium: boolean; days: number | null; errors: string[] }

/** Header: login,display_name,access,premium_days. Rows are validated here; collisions with existing accounts are checked by the caller. */
export function parseImport(text: string, maxRows: number): { rows: ImportRow[]; fileError: string | null } {
  const table = parseCsv(text);
  if (!table.length) return { rows: [], fileError: 'The file is empty' };
  const head = table[0]!.map((h) => h.trim().toLowerCase());
  const col = (n: string) => head.indexOf(n);
  if (col('login') < 0) return { rows: [], fileError: 'The first row must name the columns: login,display_name,access,premium_days' };
  const body = table.slice(1);
  if (body.length > maxRows) return { rows: [], fileError: `At most ${maxRows} accounts per import` };
  const seen = new Set<string>();
  const rows = body.map((r, i): ImportRow => {
    const get = (n: string) => (col(n) >= 0 ? (r[col(n)] ?? '').trim() : '');
    const errors: string[] = [];
    const login = get('login').toLowerCase();
    if (!LOGIN_RE.test(login)) errors.push('Login must be 3–20 lowercase letters or digits, starting with a letter');
    else if (!passwordOk(login)) errors.push('Login is too short: its password would be under 8 characters');
    if (seen.has(login)) errors.push('Login appears twice in this file');
    seen.add(login);
    const access = (get('access') || 'free').toLowerCase();
    if (access !== 'free' && access !== 'premium') errors.push('Access must be free or premium');
    let days: number | null = null;
    if (access === 'premium') {
      days = Number(get('premium_days'));
      if (!Number.isInteger(days) || days < 1 || days > 365) errors.push('Premium needs premium_days between 1 and 365');
    }
    const name = get('display_name');
    if (name.length > 30) errors.push('Display name is longer than 30 characters');
    return { line: i + 2, login, displayName: name || null, premium: access === 'premium', days, errors };
  });
  return { rows, fileError: null };
}
