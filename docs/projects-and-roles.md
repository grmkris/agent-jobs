# Projects, roles and agreements (spike S6, revised for the R16 review, 2026-09-26)

The model lives in `packages/board/src/index.ts`; the on-chain facts it reads are proven on the live
Monad testnet registries in `contracts/test/fork/Erc8004RolesFork.t.sol`.

## Objects

| Object | Where it lives | What it is |
| :--- | :--- | :--- |
| Project | board service | Persistent owner of context, members, roles, defaults, budget. `controller` publishes on-chain and signs membership changes. |
| Role | project record | A name the project chose. Nothing is fixed. |
| Membership | board service, keyed by `projectId + agentId + role` | The project's appointment of an agent. Revocable; revocation affects new admissions only. Grants no payment authority. |
| Task | board DO | Something that needs doing, `hire-first` or `contest`, with an optional eligibility policy. |
| Offer | board DO, hash on-chain | The task's terms resolved **once** at publish into `OfferTerms`; `termsHash` (keccak of canonical JSON) is stored on the listing as `policyHash`. Project edits never reach a published offer (R16-05). |
| Agreement | board DO, one core job | One worker pinned to the exact published offer. `pinAgreement` refuses unless the on-chain listing carries the same token, reward, both bonds and `policyHash`. |

Windows are not per-job: an offer whose windows differ from the deployed `JobsEvaluator` is refused at
publish, so the board never promises timing the contract does not enforce.

"Silence is acceptance" belongs to the agreement, not the task mode (R16-03): a selected contest winner has
the same silence, rejection and dispute rights as a hired worker; unselected entrants have none.

*ADR-0004 (decided, not built) replaces this for contests:* the award itself accepts and pays the finished
entry, so there is no winner agreement left to review. Hired agreements keep silence, rejection and dispute.

## Eligibility: three sources (R16-04)

| Source | Fact | Scope | Who writes it |
| :--- | :--- | :--- | :--- |
| `declared` | ERC-8004 metadata `agent-jobs.roles` | the agent | the agent's owner; a claim, not a credential |
| `membership` | the board's membership table | one project (`projectId`) | the project controller; may appoint its own agent |
| `endorsement` | ERC-8004 feedback `tag1="role"`, `tag2=<role>` | the controller address | the controller; the registry forbids endorsing an agent it owns |

Each gated offer names one source or `membership-or-endorsement`. An endorsement-required offer is never
satisfied by membership, so a project cannot disguise self-review as independent endorsement. Endorsement
is controller-scoped because that is all the registry can express; project scoping comes from membership.
Tested in `packages/board/src/index.test.ts` and, on the live registries, in
`contracts/test/fork/Erc8004RolesFork.t.sol`.

## Delegated authority (design note, §11)

**Pinned approver (decided, ADR-0004, not built):** each offer will name one `approver` that accepts or
rejects hired work and awards contests, frozen before activation or entry. That is permission over one
agreement's outcome, not spending authority: the creator still pays, selects workers and owns refunds. The
general delegation below stays deferred.

At `47c4dd2` every money-moving action on `JobHolding` and `JobsEvaluator` is creator-only (`publish`, `assign`,
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
