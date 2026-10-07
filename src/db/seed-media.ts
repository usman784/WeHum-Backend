/**
 * Demo servers only: the seed creates media rows (`seed/audio/….m4a`) without files, so nothing could play.
 * This renders a quiet placeholder tone of the right length for each of them (ffmpeg, already in the image) and
 * uploads it to its storage key. Not Raphael's recordings: real audio is uploaded in the CMS. Idempotent.
 *   node dist/db/seed-media.js
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { S3Service } from '../infra/s3';
import { createPool } from './client';

const run = promisify(execFile);

/** A soft two-note drone (136.1 Hz + a fifth) with a gentle fade in and out, mono AAC at 16 kbit/s. */
async function tone(path: string, sec: number) {
  const fade = Math.min(3, sec / 4);
  await run('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=136.1:duration=${sec}:sample_rate=22050`,
    '-f', 'lavfi', '-i', `sine=frequency=204.15:duration=${sec}:sample_rate=22050`,
    '-filter_complex', `amix=inputs=2,volume=0.35,afade=t=in:d=${fade},afade=t=out:st=${sec - fade}:d=${fade}`,
    '-c:a', 'aac', '-b:a', '16k', '-ac', '1', '-movflags', '+faststart', path,
  ], { maxBuffer: 1 << 20 });
}

export async function seedMedia(url?: string) {
  const pool = createPool(url);
  const s3 = new S3Service();
  const dir = await mkdtemp(join(tmpdir(), 'wehum-seed-'));
  try {
    await s3.ensureBucket();
    const rows = (await pool.query(`SELECT storage_key AS key, coalesce(duration_sec, 60) AS sec FROM media_assets WHERE storage_key LIKE 'seed/audio/%' ORDER BY 2`)).rows as { key: string; sec: number }[];
    const bySec = new Map<number, string[]>();
    for (const r of rows) bySec.set(r.sec, [...(bySec.get(r.sec) ?? []), r.key]);
    for (const [sec, keys] of bySec) {
      const file = join(dir, `${sec}.m4a`);
      await tone(file, Math.max(2, sec));
      const body = await readFile(file);
      for (const key of keys) await s3.putBuffer(key, body, 'audio/mp4');
      await rm(file);
      console.log(`${sec}s × ${keys.length} (${(body.length / 1024).toFixed(0)} KB each)`);
    }
    console.log(`placeholder audio for ${rows.length} media rows`);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await pool.end();
  }
}

if (require.main === module) seedMedia().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
