/**
 * Generates an Ed25519 JWT key pair + TOTP encryption key and writes them into .env (only if empty).
 * Usage: npm run keys
 */
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';

async function main() {
  if (!existsSync('.env')) copyFileSync('.env.example', '.env');
  let env = readFileSync('.env', 'utf8');
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const kid = `k${Date.now().toString(36)}`;
  const priv = Buffer.from(await exportPKCS8(privateKey)).toString('base64');
  const pubs = Buffer.from(JSON.stringify([{ kid, pem: await exportSPKI(publicKey) }])).toString('base64');
  const set = (k: string, v: string) => {
    const re = new RegExp(`^${k}=.*$`, 'm');
    const line = `${k}=${v}`;
    if (re.test(env)) {
      if (new RegExp(`^${k}=.+$`, 'm').test(env) && !process.argv.includes('--force')) return console.log(`${k} already set (use --force to replace)`);
      env = env.replace(re, line);
    } else env += `\n${line}`;
    console.log(`${k} written`);
  };
  set('JWT_PRIVATE_KEY_B64', priv);
  set('JWT_PUBLIC_KEYS_B64', pubs);
  set('JWT_KID', kid);
  set('TOTP_ENC_KEY_BASE64', randomBytes(32).toString('base64'));
  writeFileSync('.env', env);
}
main();
