import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { K, REDIS } from '../../infra/redis';
import { ConfigService, type GroupConfig } from '../config/config.service';
import { MotdService, addDaysIso } from '../motd/motd.service';

export type GroupState = 'scheduled' | 'lobby' | 'live' | 'ended';
const LOBBY_FRESH_MS = 90_000;
const HOUR_MS = 3_600_000;

/** A slot id is the date (`2026-10-12`, the daily group sit) or the date and UTC hour (`2026-10-12T08`, an hourly sit). */
export const SLOT = /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]))?$/;
export const slotDate = (slot: string) => slot.slice(0, 10);
export const slotHour = (slot: string) => (slot.length > 10 ? Number(slot.slice(11, 13)) : null);
export const hourSlot = (ms: number) => new Date(ms).toISOString().slice(0, 13);

/** Group meditation timing (spec §8.1). Everything is a UTC instant; the app shows local times. */
@Injectable()
export class GroupService {
  constructor(@Inject(REDIS) private readonly redis: Redis, private readonly config: ConfigService, private readonly motd: MotdService) {}

  /** The daily group sit of a date (one configured start time, or the MOTD day's override). */
  async forDate(date: string, now = Date.now()) { return this.forSlot(date, now); }

  /** One sit by slot id. Hourly slots start on the hour and use the MOTD of that date at the configured length. */
  async forSlot(slot: string, now = Date.now()) {
    const cfg = await this.config.value<GroupConfig>('group');
    const date = slotDate(slot), hour = slotHour(slot);
    const day = await this.motd.forDate(date).catch(() => null);
    let startsAt: number, lengthMin: number;
    if (hour === null) {
      const startUtc = day?.group.startUtc ?? cfg.startUtc;
      lengthMin = day?.group.lengthMin ?? cfg.lengthMin;
      startsAt = Date.parse(`${date}T${startUtc}:00Z`);
    } else {
      lengthMin = cfg.hourly?.lengthMin ?? 10;
      startsAt = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
    }
    const endsAt = startsAt + lengthMin * 60_000, lobbyOpensAt = startsAt - cfg.lobbyOpenMin * 60_000;
    const state: GroupState = now < lobbyOpensAt ? 'scheduled' : now < startsAt ? 'lobby' : now < endsAt ? 'live' : 'ended';
    // people who are in the lobby right now (each lobby client refreshes its score; stale entries do not count)
    const waiting = await this.redis.zcount(K.lobby(slot), now - LOBBY_FRESH_MS, '+inf').catch(() => 0);
    return {
      date: slot, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(), lobbyOpensAt: new Date(lobbyOpensAt).toISOString(),
      lengthMin, reminderMin: cfg.reminderMin, state, waiting, sessionId: day?.sessionId ?? null, title: day?.title ?? null,
    };
  }

  /** Slot ids the lobby and the start scheduler have to watch right now. */
  async slots(now = Date.now()): Promise<string[]> {
    const today = new Date(now).toISOString().slice(0, 10);
    const cfg = await this.config.value<GroupConfig>('group');
    const out = [today, addDaysIso(today, 1)];
    if (cfg.cadence === 'hourly' && cfg.hourly) {
      for (let i = 0; i <= 2; i++) {
        const t = Math.floor(now / HOUR_MS) * HOUR_MS + i * HOUR_MS, h = new Date(t).getUTCHours();
        if (h >= cfg.hourly.fromHourUtc && h <= cfg.hourly.toHourUtc) out.push(hourSlot(t));
      }
    }
    return out;
  }

  /** The next sit that is not over: today's (or tomorrow's) daily sit, or the next hour inside the hourly window. */
  async next(now = Date.now()) {
    const cfg = await this.config.value<GroupConfig>('group');
    const today = new Date(now).toISOString().slice(0, 10);
    if (cfg.cadence === 'hourly' && cfg.hourly) {
      const { fromHourUtc, toHourUtc } = cfg.hourly;
      // look at most 48 hours ahead: the current hour (if still live) or the next one inside the window
      for (let i = -1; i < 48; i++) {
        const t = Math.floor(now / HOUR_MS) * HOUR_MS + i * HOUR_MS, h = new Date(t).getUTCHours();
        if (h < fromHourUtc || h > toHourUtc) continue;
        const g = await this.forSlot(hourSlot(t), now);
        if (g.state !== 'ended') return g;
      }
    }
    const t = await this.forDate(today, now);
    return t.state === 'ended' ? this.forDate(addDaysIso(today, 1), now) : t;
  }

  /** Cadence, intentions and the "today's focus" card for the lobby and the countdown screen. */
  async details() {
    const cfg = await this.config.value<GroupConfig>('group');
    return { cadence: cfg.cadence ?? 'daily', intentions: cfg.intentions ?? [], focus: cfg.focus?.title ? cfg.focus : null, doorsOpenSec: cfg.doorsOpenSec ?? 60 };
  }
}
