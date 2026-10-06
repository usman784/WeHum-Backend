import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../../config/env';
import type { DB } from '../../infra/core.module';
import type { RealtimeBus } from '../../infra/realtime-bus';
import { TokensService } from './tokens.service';

// Without configured keys (local dev, the CMS e2e backend) the service makes a key pair on first use. Found by the CMS restart e2e:
// a token check and a sign at the same moment right after a start each made their own pair, and every token
// signed with the losing pair stayed invalid until the next restart.
describe('TokensService keys', () => {
  const configured = env.JWT_PRIVATE_KEY_B64;
  afterEach(() => { env.JWT_PRIVATE_KEY_B64 = configured; });

  it('first calls at the same moment share one key pair', async () => {
    env.JWT_PRIVATE_KEY_B64 = ''; // the dev path: no keys configured
    const svc = new TokensService({} as DB, {} as never, {} as RealtimeBus);
    const claims = { sub: '00000000-0000-0000-0000-000000000001', role: 'owner', name: 'A', ver: 0 } as const;
    // key pairs finish in any order; with two signers at most one can be the last, so a race always breaks one token
    const [a, , b] = await Promise.all([
      svc.signAccess(claims, 'wehum-cms'),
      svc.verify('not-a-token', 'wehum-cms').catch(() => null),
      svc.signAccess(claims, 'wehum-cms'),
    ]);
    await expect(svc.verify(a, 'wehum-cms')).resolves.toMatchObject({ sub: claims.sub });
    await expect(svc.verify(b as string, 'wehum-cms')).resolves.toMatchObject({ sub: claims.sub });
  });
});
