import * as Cloudflare from 'alchemy/Cloudflare'

/** Discovery data for Explore. Written only by the indexer (B3); migrations arrive with it. */
export const Database = Cloudflare.D1.Database('Database')
