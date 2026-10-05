import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../config/env';

const run = promisify(execFile);
const BIG = 64 * 1024 * 1024;

export interface Probe { durationSec: number; codec: string | null; width: number | null; height: number | null; hasVideo: boolean; hasAudio: boolean }

/** ffprobe → duration, codec, size (spec §8.5 `media_probe`). */
export async function probe(path: string): Promise<Probe> {
  const { stdout } = await run(env.FFPROBE_PATH, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { maxBuffer: BIG });
  const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string; codec_name?: string; width?: number; height?: number; duration?: string }[] };
  const v = j.streams?.find((s) => s.codec_type === 'video'), a = j.streams?.find((s) => s.codec_type === 'audio');
  const dur = Number(j.format?.duration ?? a?.duration ?? v?.duration ?? 0);
  return { durationSec: Math.round(dur), codec: (a ?? v)?.codec_name ?? null, width: v?.width ?? null, height: v?.height ?? null, hasVideo: !!v && v.codec_name !== 'mjpeg' && v.codec_name !== 'png', hasAudio: !!a };
}

/** Integrated loudness via `ffmpeg -af ebur128` (spec §8.5 `media_loudness`). Target −16 LUFS ±1. */
export async function integratedLufs(path: string): Promise<number | null> {
  const { stderr } = await run(env.FFMPEG_PATH, ['-hide_banner', '-nostats', '-i', path, '-vn', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { maxBuffer: BIG });
  const m = /Integrated loudness:[\s\S]*?I:\s*(-?[\d.]+)\s*LUFS/.exec(stderr);
  return m ? Math.round(Number(m[1]) * 100) / 100 : null;
}

/** Mean volume (dB) of a slice — used to check that a loop is seamless. */
async function meanVolume(path: string, start: number, len: number): Promise<number | null> {
  const { stderr } = await run(env.FFMPEG_PATH, ['-hide_banner', '-nostats', '-ss', String(start), '-t', String(len), '-i', path, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { maxBuffer: BIG });
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr);
  return m && m[1] !== '-inf' ? Number(m[1]) : null;
}

/** Compares the level of the first and last 200 ms; a jump above 3 dB would click when the sound loops. */
export async function loopCheck(path: string, durationSec: number) {
  if (durationSec < 1) return { seamless: false, diffDb: null as number | null };
  const [head, tail] = await Promise.all([meanVolume(path, 0, 0.2), meanVolume(path, Math.max(0, durationSec - 0.2), 0.2)]);
  if (head === null || tail === null) return { seamless: head === tail, diffDb: null };
  const diffDb = Math.round(Math.abs(head - tail) * 10) / 10;
  return { seamless: diffDb <= 3, diffDb };
}

/** AAC-LC 128 kbps, 44.1 kHz stereo (voice-only content may use 96 kbps). */
export async function transcodeAudio(input: string, output: string, bitrate = '128k') {
  await run(env.FFMPEG_PATH, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-c:a', 'aac', '-b:a', bitrate, '-ar', '44100', '-ac', '2', '-movflags', '+faststart', output], { maxBuffer: BIG });
}

/** H.264 720p MP4 with AAC audio, fast-start for streaming. */
export async function transcodeVideo(input: string, output: string) {
  await run(env.FFMPEG_PATH, [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', output,
  ], { maxBuffer: BIG });
}
