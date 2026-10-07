import { Injectable, Logger } from '@nestjs/common';
import { importPKCS8, SignJWT } from 'jose';
import { env } from '../../config/env';

export interface PushMessage { token: string; title: string; body: string; data: Record<string, string> }
export type TopicOp = 'subscribe' | 'unsubscribe';
/** Each user has one FCM topic; every device of theirs is subscribed while it is signed in. */
export const userTopic = (userId: string) => `user_${userId}`;
export type PushResult = { token: string; status: 'ok' | 'invalid' | 'failed' };

/**
 * FCM HTTP v1 (spec §8.3): the only thing Firebase is used for. iOS goes through APNs configured inside FCM.
 * Tests replace `impl`; with no service account configured nothing is sent (every message "fails" softly).
 */
@Injectable()
export class PushTransport {
  private readonly log = new Logger('Push');
  private cached?: { token: string; exp: number };
  /** Replaced in tests. */
  impl: (messages: PushMessage[]) => Promise<PushResult[]> = (m) => this.sendFcm(m);

  /** Replaced in tests. Best effort: never throws, returns false when FCM said no. */
  topicImpl: (op: TopicOp, topic: string, tokens: string[]) => Promise<boolean> = (op, topic, tokens) => this.topicFcm(op, topic, tokens);

  send(messages: PushMessage[]) { return this.impl(messages); }
  subscribe(userId: string, tokens: string[]) { return this.topic('subscribe', userId, tokens); }
  unsubscribe(userId: string, tokens: string[]) { return this.topic('unsubscribe', userId, tokens); }

  private async topic(op: TopicOp, userId: string, tokens: string[]) {
    const list = [...new Set(tokens.filter(Boolean))];
    if (!list.length) return true;
    let ok = true;
    for (let i = 0; i < list.length; i += 1000) ok = (await this.topicImpl(op, userTopic(userId), list.slice(i, i + 1000))) && ok;
    return ok;
  }

  private async topicFcm(op: TopicOp, topic: string, tokens: string[]): Promise<boolean> {
    const sa = this.account();
    if (!sa) return false;
    try {
      const access = await this.accessToken(sa);
      const res = await fetch(`https://iid.googleapis.com/iid/v1:${op === 'subscribe' ? 'batchAdd' : 'batchRemove'}`, {
        method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', access_token_auth: 'true' }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ to: `/topics/${topic}`, registration_tokens: tokens }),
      });
      if (!res.ok) this.log.warn(`Topic ${op} ${res.status}`);
      return res.ok;
    } catch (e) { this.log.warn(`Topic ${op} failed: ${(e as Error).message}`); return false; }
  }

  private account() {
    if (!env.FCM_SERVICE_ACCOUNT_JSON) return null;
    try { return JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON) as { project_id: string; client_email: string; private_key: string }; } catch { return null; }
  }

  private async accessToken(sa: NonNullable<ReturnType<PushTransport['account']>>) {
    if (this.cached && this.cached.exp > Date.now() + 60_000) return this.cached.token;
    const key = await importPKCS8(sa.private_key, 'RS256');
    const jwt = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
      .setProtectedHeader({ alg: 'RS256' }).setIssuer(sa.client_email).setSubject(sa.client_email).setAudience('https://oauth2.googleapis.com/token').setIssuedAt().setExpirationTime('55m').sign(key);
    const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
    if (!res.ok) throw new Error(`FCM auth ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  private async sendFcm(messages: PushMessage[]): Promise<PushResult[]> {
    const sa = this.account();
    if (!sa) { this.log.warn('FCM is not configured: push not sent'); return messages.map((m) => ({ token: m.token, status: 'failed' as const })); }
    let access: string;
    try { access = await this.accessToken(sa); } catch (e) { this.log.error((e as Error).message); return messages.map((m) => ({ token: m.token, status: 'failed' as const })); }
    const out: PushResult[] = [];
    const queue = [...messages];
    const worker = async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        try {
          const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
            method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
            body: JSON.stringify({ message: { token: m.token, notification: { title: m.title, body: m.body }, data: m.data, apns: { payload: { aps: { 'mutable-content': 1 } } } } }),
          });
          if (res.ok) out.push({ token: m.token, status: 'ok' });
          else {
            const txt = await res.text();
            out.push({ token: m.token, status: res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(txt) ? 'invalid' : 'failed' });
          }
        } catch { out.push({ token: m.token, status: 'failed' }); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(50, messages.length) }, worker));
    return out;
  }
}
