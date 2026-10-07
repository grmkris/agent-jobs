import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

rmSync(join(homedir(), '.alchemy', 'credentials', 'default', 'cloudflare-state-store.json'), { force: true })
console.log('state-store: credential removed')
