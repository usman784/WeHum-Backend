import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env, isProd } from '../../config/env';

/** TOTP secrets are stored AES-256-GCM encrypted (`iv|tag|ciphertext`, base64) with TOTP_ENC_KEY_BASE64. */
function key(): Buffer {
  if (env.TOTP_ENC_KEY_BASE64) {
    const k = Buffer.from(env.TOTP_ENC_KEY_BASE64, 'base64');
    if (k.length !== 32) throw new Error('TOTP_ENC_KEY_BASE64 must decode to 32 bytes');
    return k;
  }
  if (isProd) throw new Error('TOTP_ENC_KEY_BASE64 missing (run npm run keys)');
  return createHash('sha256').update('wehum-dev-totp-key').digest(); // dev/test only
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(enc: string): string {
  const b = Buffer.from(enc, 'base64');
  const d = createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
