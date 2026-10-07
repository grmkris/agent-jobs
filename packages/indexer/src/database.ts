import * as Cloudflare from 'alchemy/Cloudflare'
import { stageProfile } from '../../../infra/stage.ts'

/** Discovery data for Explore and the directory projection. The release runner
 * opts into this generated directory migration after its preflight gates. */
const migrationOptions =
  process.env.SIDEQUEST_APPLY_MIGRATIONS === '1'
    ? { migrations: new URL('../../../apps/api/migrations', import.meta.url).pathname }
    : undefined
/** Alchemy reads D1's `readReplication` back as `{ mode: 'disabled' }` but stores it only when set, so drift flags a
 *  database created without it. Disabled is D1's default and the live setting; declaring it changes nothing on Cloudflare. */
export const Database = Cloudflare.D1.Database('Database', {
  ...(stageProfile() ? { name: stageProfile()!.resources.Database } : {}),
  readReplication: { mode: 'disabled' },
  ...migrationOptions,
})
