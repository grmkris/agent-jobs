import * as Cloudflare from 'alchemy/Cloudflare'
import { stageProfile } from '../../../infra/stage.ts'

/** Discovery data for Explore and the directory projection. The release runner
 * opts into this generated directory migration after its preflight gates. */
const migrationOptions = process.env.SIDEQUEST_APPLY_MIGRATIONS === '1'
  ? { migrations: new URL('../../../apps/api/migrations', import.meta.url).pathname }
  : undefined
export const Database = Cloudflare.D1.Database('Database', {
  ...(stageProfile() ? { name: stageProfile()!.resources.Database } : {}),
  ...migrationOptions,
})
