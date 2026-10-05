import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_META } from '../src/common/auth';
import { adminToken, bootApp, guest, http, makeAdmin, resetTestDb, type AdminRole } from './helpers';

const ROLES: AdminRole[] = ['owner', 'admin', 'editor', 'moderator'];
const NIL = '00000000-0000-0000-0000-000000000000';
let app: NestFastifyApplication;
let db: Client;

interface AdminRoute { method: string; path: string; url: string; public: boolean; roles: string[] }

/** Every `/v1/admin/*` route, read from the controllers' metadata (so a new route cannot slip in unguarded). */
function adminRoutes(): AdminRoute[] {
  const out: AdminRoute[] = [];
  const verb = (m: number) => RequestMethod[m]!;
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const ctrl = wrapper.metatype as { prototype: Record<string, unknown> };
      const base = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '');
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const fn = ctrl.prototype[name] as object;
        if (typeof fn !== 'function' || Reflect.getMetadata(METHOD_METADATA, fn) === undefined) continue;
        const path = `/${base}/${Reflect.getMetadata(PATH_METADATA, fn) ?? ''}`.replace(/\/+/g, '/').replace(/\/$/, '');
        if (!path.startsWith('/v1/admin')) continue;
        const roles = (Reflect.getMetadata(AUTH_META.ROLES, fn) ?? Reflect.getMetadata(AUTH_META.ROLES, ctrl) ?? []) as string[];
        const isPublic = !!(Reflect.getMetadata(AUTH_META.PUBLIC, fn) ?? Reflect.getMetadata(AUTH_META.PUBLIC, ctrl));
        const url = path.replace(':key', 'main').replace(':date', '2030-01-01').replace(':len', '30').replace(/:\w+/g, NIL);
        out.push({ method: verb(Reflect.getMetadata(METHOD_METADATA, fn)), path, url, public: isPublic, roles });
      }
    }
  }
  return out;
}

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
});
afterAll(async () => { await db?.end(); await app?.close(); });

describe('P3 role matrix (4 roles × every admin route)', () => {
  it('finds the admin API and every non-public route declares its roles', () => {
    const routes = adminRoutes();
    expect(routes.length).toBeGreaterThan(55);
    const unguarded = routes.filter((r) => !r.public && r.roles.length === 0).map((r) => `${r.method} ${r.path}`);
    expect(unguarded).toEqual([]);
    const publicOnes = routes.filter((r) => r.public).map((r) => r.path);
    expect(publicOnes.every((p) => p.startsWith('/v1/admin/auth/'))).toBe(true); // nothing public except the sign-in family
  });

  it('no token → 401, app (guest) token → 401, for every protected route', async () => {
    const g = await guest(app);
    for (const r of adminRoutes().filter((x) => !x.public)) {
      const call = (token?: string) => http(app).request(r.method, r.url, { token, body: r.method === 'GET' || r.method === 'DELETE' ? undefined : {} });
      expect((await call()).status, `${r.method} ${r.path} without token`).toBe(401);
      expect((await call(g.accessToken)).status, `${r.method} ${r.path} with an app token`).toBe(401);
    }
  });

  it('each role gets 403 exactly where the spec says, and never a 5xx where allowed', async () => {
    const routes = adminRoutes().filter((x) => !x.public);
    const tokens: Record<string, string> = {};
    for (const role of ROLES) tokens[role] = await adminToken(app, await makeAdmin(db, role));
    const denied: string[] = [], leaked: string[] = [], crashed: string[] = [];
    for (const r of routes) {
      for (const role of ROLES) {
        const token = tokens[role]!;
        const res = await http(app).request(r.method, r.url, { token, body: r.method === 'GET' || r.method === 'DELETE' ? undefined : {} });
        const allowed = r.roles.includes(role);
        if (allowed && (res.status === 401 || res.status === 403)) denied.push(`${role} ${r.method} ${r.path} → ${res.status}`);
        if (!allowed && res.status !== 403) leaked.push(`${role} ${r.method} ${r.path} → ${res.status}`);
        if (res.status >= 500) crashed.push(`${role} ${r.method} ${r.path} → ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
      }
    }
    expect(denied, 'allowed role was refused').toEqual([]);
    expect(leaked, 'forbidden role got through').toEqual([]);
    expect(crashed, 'server errors').toEqual([]);
  });

  it('matches the capability table of the CMS spec (§6.2)', () => {
    const by = (p: string, m = 'GET') => adminRoutes().find((r) => r.method === m && r.path === p)!.roles;
    expect(by('/v1/admin/sessions')).toEqual(['owner', 'admin', 'editor']);
    expect(by('/v1/admin/sessions/:id', 'DELETE')).toEqual(['owner', 'admin']); // editors cannot delete
    expect(by('/v1/admin/team')).toEqual(['owner', 'admin']);
    expect(by('/v1/admin/audit')).toEqual(['owner', 'admin']);
    expect(by('/v1/admin/config')).toEqual(['owner', 'admin']);
    expect(by('/v1/admin/config/today')).toEqual(['owner', 'admin', 'editor']);
    expect(by('/v1/admin/group', 'PUT')).toEqual(['owner', 'admin', 'editor']);
    expect(by('/v1/admin/media/uploads', 'POST')).toEqual(['owner', 'admin', 'editor']);
    expect(by('/v1/admin/me')).toEqual(['owner', 'admin', 'editor', 'moderator']);
    expect(by('/v1/admin/jobs/:id')).toEqual(['owner', 'admin', 'editor', 'moderator']);
  });
});
