/** Text checks for dedications (spec §8.6). Pure functions: the rules (on/off, crisis words) come from `app_config.moderation`. */

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't' };

/** Lower case, no accents, leetspeak undone, one space between words. */
export function normalize(text: string): string {
  return text
    .normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[0134@$!|+57]/g, (c) => LEET[c] ?? c)
    .replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Links, domains and handles. Spelled-out dots ("example dot com") count too. */
export function hasLink(text: string): boolean {
  const t = text.toLowerCase().replace(/\s*\(?\bdot\b\)?\s*/g, '.').replace(/\s*\[\.\]\s*/g, '.');
  return /https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|net|org|io|app|me|co|ly|link|xyz|info|de|uk|ch|at|eu|tv|gl|be)\b|(^|[\s(])@[a-z0-9_.]{2,}/i.test(t);
}

/** Whole words only (so "class" is fine), plus words spelled with spaces or dots between the letters ("f u c k"). */
const WORDS = ['fuck', 'fucking', 'fucker', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'slut', 'whore', 'nigger', 'nigga', 'faggot', 'retard', 'motherfucker', 'bullshit', 'dumbass', 'piss'];
export function hasProfanity(text: string): boolean {
  const n = normalize(text);
  const tokens = n.split(' ');
  if (tokens.some((w) => WORDS.includes(w))) return true;
  // runs of single letters: "f u c k"
  const runs: string[] = [];
  let cur = '';
  for (const w of tokens) { if (w.length === 1) cur += w; else { if (cur.length > 2) runs.push(cur); cur = ''; } }
  if (cur.length > 2) runs.push(cur);
  return runs.some((r) => WORDS.some((w) => r.includes(w)));
}

/** Crisis phrases from the settings, matched as whole words on the normalized text ("self-harm" = "self harm"; "suicidal" starts with "suicid" only if the phrase is that stem). Returns the phrases found. */
export function crisisHits(text: string, words: string[]): string[] {
  const n = ` ${normalize(text)} `;
  return words.filter((w) => { const k = normalize(w); return k.length > 1 && n.includes(` ${k} `); });
}
