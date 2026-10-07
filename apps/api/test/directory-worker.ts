import * as Cloudflare from 'alchemy/Cloudflare'
import { Database } from '../src/database.ts'
import { directoryProbeHandler } from './directory-worker-handler.ts'

export default class DirectoryMainnetProbe extends Cloudflare.Worker<DirectoryMainnetProbe>()(
  'SidequestDirectoryMainnetProbe',
  {
    main: import.meta.url,
    compatibility: { date: '2026-09-01' },
    env: { DIRECTORY_DATABASE: Database, NETWORK: 'monad-mainnet', DEPLOY_STAGE: 'prod', PROD_ADMISSION_DRAIN: '0' },
  },
  directoryProbeHandler,
) {}
