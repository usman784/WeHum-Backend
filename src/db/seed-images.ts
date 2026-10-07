/**
 * Uploads the demo cover images the seed points at (`img/<name>.jpg`) to the media bucket. Idempotent.
 *   node dist/db/seed-images.js <folder with .jpg files>
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { S3Service } from '../infra/s3';

export async function seedImages(dir: string) {
  const s3 = new S3Service();
  await s3.ensureBucket();
  const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.jpg'));
  for (const f of files) await s3.putBuffer(`img/${f}`, await readFile(join(dir, f)), 'image/jpeg');
  console.log(`uploaded ${files.length} cover images`);
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: seed-images <folder>'); process.exit(1); }
  seedImages(dir).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
