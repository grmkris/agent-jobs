import { DirectoryError, type Sql } from '@agent-jobs/board'
import type { AsyncSql } from '@agent-jobs/indexer'
import type { DirectoryAgent } from '@agent-jobs/sdk'
import type { DirectoryCall } from './directory-object.ts'
import { migrateDirectory, projectDirectory } from './directory.ts'

export type DirectoryScope = Pick<DirectoryCall, 'network' | 'audience' | 'agentId'>

export class DirectoryProjectionJournal {
  constructor(readonly storage: Sql) {
    storage.run('CREATE TABLE IF NOT EXISTS directory_projection (id INTEGER PRIMARY KEY CHECK (id = 1), scope TEXT NOT NULL, revision INTEGER NOT NULL)')
  }

  prepare(scope: DirectoryScope): void {
    this.storage.run('INSERT INTO directory_projection (id, scope, revision) VALUES (1, ?, 0) ON CONFLICT (id) DO NOTHING', JSON.stringify(scope))
    const current = this.scope()
    if (current?.network !== scope.network || current.audience !== scope.audience || current.agentId !== scope.agentId) throw new DirectoryError('forbidden', 'directory owner scope cannot change')
  }

  scope(): DirectoryScope | null {
    const [row] = this.storage.all<{ scope: string }>('SELECT scope FROM directory_projection WHERE id = 1')
    return row === undefined ? null : JSON.parse(row.scope) as DirectoryScope
  }

  async flush(sql: AsyncSql, agent: DirectoryAgent): Promise<void> {
    const [row] = this.storage.all<{ scope: string; revision: number }>('SELECT scope, revision FROM directory_projection WHERE id = 1')
    if (row === undefined || row.revision >= agent.revision) return
    const scope = JSON.parse(row.scope) as DirectoryScope
    await migrateDirectory(sql)
    await projectDirectory(sql, agent, scope.audience)
    this.storage.run('UPDATE directory_projection SET revision = ? WHERE id = 1', agent.revision)
  }
}
