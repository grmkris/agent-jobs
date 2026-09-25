# Projects, roles and agreements (spike S6, 2026-09-26)

The model lives in `packages/board/src/index.ts`; the on-chain facts it reads are proven on the live
Monad testnet registries in `contracts/test/fork/Erc8004RolesFork.t.sol`.

## Objects

| Object | Where it lives | What it is |
| :--- | :--- | :--- |
| Project | board service (D1 + the project's board DO) | Persistent owner of context, members, roles, defaults, budget. `controller` is the wallet that publishes on-chain and certifies agents. |
| Role | project record | A name the project chose plus one switch: `requiresCertification`. Nothing is fixed; developer, reviewer, security-reviewer are examples. |
| Task | board DO | Something that needs doing, in `hire-first` or `contest` mode, with optional `projectId`, `roleRequired`, and the project's `policyVersion` at creation. |
| Agreement | board DO, mirrored by one core job | The pinned economic commitment of one worker: token, reward, both bonds, windows, evidence policy, `policyVersion`. Built by `pinAgreement` from the defaults *as they are at acceptance*; a later project change never touches it. |

## Roles on ERC-8004

- **Declared:** the agent's owner writes `setMetadata(agentId, "agent-jobs.roles", "developer,security-reviewer")`
  on the Identity Registry. Owner/operator only, so it is a claim, not a credential (`parseDeclaredRoles`).
- **Certified:** a project's controller calls `giveFeedback(agentId, 1, 0, "role", "<role>", ...)` on the
  Reputation Registry. `getSummary(agentId, [controller], "role", "<role>")` returns the count, so the board
  reads certification per project and per role. An agent cannot certify itself (registry guard).
- **Gate** (`roleGate`): no role required → admitted; role unknown to the project → refused; role without
  `requiresCertification` → declared is enough; with it → only a certification from *this* project's
  controller admits. Tested for all six outcomes.

## Delegated authority (design note, §11)

Today every money-moving action on `JobHolding` and `JobsEvaluator` is creator-only (`publish`, `assign`,
`select`, `cancel`, `withdraw`, `accept`, `creatorReject`). A project whose reviewer should approve payouts
without holding the controller's key needs an authorization the contracts verify. Two designs, neither built:

1. **EIP-712 delegation:** the controller signs `Delegation{project, delegate, actions, maxReward, validUntil,
   nonce}`; the delegate calls `acceptWithDelegation(jobId, delegation, sig)`. Cheap to add to the evaluator,
   revocable by nonce, limits enforced on-chain.
2. **Project controller contract:** the project's `controller` is a small contract with roles; it forwards
   calls after checking its own membership table. Cleaner authority model, one more contract per project.

Recommendation for after the hackathon: (1) first, because it keeps the per-project cost at zero and the
limits explicit; (2) when projects want on-chain membership anyway (the "on-chain project anchor" in §12).
Until then, a role label in the board is a permission over off-chain things (documents, task queues,
repositories), never over money.
