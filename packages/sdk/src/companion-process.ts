/** Environment boundary for the coding-agent child. Values not on this list never cross into the worker. */
export const CHILD_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CLAUDE_CONFIG_DIR', 'NO_COLOR',
] as const

export function childEnvironment(parent: Record<string, string | undefined>, managedId: string, apiOrigin: string): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = parent[name]
    if (value !== undefined) environment[name] = value
  }
  environment.HIRELING_MANAGED_AGENT_ID = managedId
  environment.HIRELING_API = apiOrigin
  return environment
}
