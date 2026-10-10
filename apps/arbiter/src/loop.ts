import type { RoleClient } from './role.ts'

export interface RoleLoopOptions {
  readonly clients: readonly RoleClient[]
  readonly once: boolean
  readonly intervalSeconds: number
  readonly pass: (client: RoleClient) => Promise<void>
  readonly log: (message: string) => void
}

/** Shared sign-in/pass/sleep lifecycle for every Commons role. */
export async function runRoleLoop(options: RoleLoopOptions): Promise<void> {
  const runPass = async (client: RoleClient): Promise<void> => {
    await client.board.signIn(client.account)
    await options.pass(client)
  }
  if (options.once) {
    for (const client of options.clients) await runPass(client)
    return
  }
  for (;;) {
    for (const client of options.clients) {
      try {
        await runPass(client)
      } catch (error) {
        options.log(
          `pass for ${client.account.address} failed: ${error instanceof Error ? error.message : 'unavailable error'}`,
        )
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, options.intervalSeconds * 1000))
  }
}
