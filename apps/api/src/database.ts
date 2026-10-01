import * as Cloudflare from 'alchemy/Cloudflare'

/** Discovery data for Explore and the directory projection. The release runner
 * opts into this generated directory migration after its preflight gates. */
const migrationOptions = process.env.AGENT_JOBS_APPLY_MIGRATIONS === '1'
  ? { migrations: new URL('../migrations', import.meta.url).pathname }
  : undefined
export const Database = Cloudflare.D1.Database('Database', migrationOptions)
