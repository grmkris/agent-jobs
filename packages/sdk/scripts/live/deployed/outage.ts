import { type Hex } from "viem";
import * as sdk from "../../../src/index.ts";
import { ORIGIN } from "./guards.ts";
import { Runtime, type Proof } from "./runtime.ts";

interface Status {
  revocation: { hostedAccessStopped?: boolean; onchainPermissionsDisabled?: boolean };
  grants: Array<{ hash: Hex; status: string }>;
}

/** Keep reads for receipt verification; abort real relay writes without replacing responses. */
export async function outage(runtime: Runtime): Promise<Proof> {
  await runtime.login();
  const { browser, chain, run } = runtime;
  const agent = runtime.agent;
  const coding = await runtime.coding();
  const token = chain.ctx.deployment.rewardTokens[0]!;
  const before = await chain.journal.once("a06/balances", async () => ({
    agent: await chain.balance(token, agent.address),
    operator: await chain.balance(token, agent.operator),
  }));
  if (before.agent <= 0n) throw new Error("P8_RECOVERY_REQUIRES_A02_EARNINGS");
  await browser.page.goto(`${ORIGIN}/workspace`);
  const card = browser.page.locator("article").filter({ hasText: agent.name });
  await card.getByText("Emergency recovery · Privy + RPC only", { exact: true }).click();
  await browser.api(`/api/agents/${agent.id}/recovery`);
  let blocked = 0;
  await browser.context.route("**/api/**", async (route) => {
    const request = route.request();
    if (new URL(request.url()).pathname.endsWith("/revoke")) {
      blocked++;
      await route.abort("blockedbyclient");
    } else await route.continue();
  });
  let status = await browser.api<Status>(`/api/agents/${agent.id}`);
  if (status.revocation.hostedAccessStopped !== true) {
    await card.getByRole("button", { name: "Stop hosted access and revoke", exact: true }).click();
    await card.getByText(/On-chain disablement is incomplete/).waitFor({ timeout: 60_000 });
    status = await browser.api<Status>(`/api/agents/${agent.id}`);
  }
  if (
    status.revocation.hostedAccessStopped !== true ||
    status.revocation.onchainPermissionsDisabled === true
  )
    throw new Error("P8_REVOKE_CONFIRMATION_BOUNDARY_BROKEN");
  await coding.assertRevoked();
  if (/On-chain permissions:\s*Disabled/i.test(await card.innerText()))
    throw new Error("P8_DISABLED_BEFORE_CHAIN_CONFIRMATION");
  await browser.context.unrouteAll({ behavior: "wait" });
  // The rest of the recovery cannot reach any hosted API or MCP path.
  await browser.context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === ORIGIN && (url.pathname.startsWith("/api/") || url.pathname === "/mcp")) {
      blocked++;
      await route.abort("blockedbyclient");
    } else await route.continue();
  });
  const completed = run.get<Hex>("a06/recovery-hash");
  let hash = completed;
  if (hash === undefined) {
    await card
      .getByRole("combobox", { name: "Recovery action", exact: true })
      .selectOption("sweep");
    await card.getByRole("textbox", { name: "Recovery token contract", exact: true }).fill(token);
    await card.getByRole("button", { name: "Review exact recovery action", exact: true }).click();
    await card.getByRole("button", { name: "Sign as this agent in Privy", exact: true }).click();
    await chain.reserve("a06/recovery", 1_500_000n);
    await card.getByRole("button", { name: "Confirm in your wallet", exact: true }).click();
    await browser.page.waitForFunction(
      () => {
        const storage = (globalThis as unknown as { localStorage: Storage }).localStorage;
        return Object.keys(storage)
          .filter((key) => key.startsWith("hireling.op:emergency-"))
          .some((key) => {
            const value = JSON.parse(storage.getItem(key) ?? "null") as { recorded?: boolean[] };
            return value?.recorded?.[0] === true;
          });
      },
      undefined,
      { timeout: 90_000 },
    );
    const hashes = await browser.cachedHashes();
    for (const candidate of hashes) {
      const transaction = await chain.ctx.publicClient.getTransaction({ hash: candidate });
      if (
        transaction.from.toLowerCase() === agent.operator.toLowerCase() &&
        transaction.to?.toLowerCase() === chain.ctx.deployment.delegation.manager.toLowerCase()
      ) {
        hash = candidate;
      }
    }
    if (hash === undefined) throw new Error("P8_RECOVERY_RECEIPT_MISSING");
    run.freeze("a06/recovery-hash", hash);
  }
  const receipt = await chain.record(hash);
  await chain.finish("a06/recovery", [hash]);
  if (
    receipt.status !== "success" ||
    (await chain.balance(token, agent.address)) !== 0n ||
    (await chain.balance(token, agent.operator)) - before.operator !== before.agent ||
    (await browser.operator()).toLowerCase() !== agent.operator.toLowerCase()
  )
    throw new Error("P8_RECOVERY_PAYMENT_OR_OPERATOR_CHANGED");
  if (blocked === 0 && completed === undefined) throw new Error("P8_RELAY_FAULT_NOT_OBSERVED");
  await browser.context.unrouteAll({ behavior: "wait" });
  await chain.reserve("a06/revoke", 3_000_000n);
  const final = await browser.api<Status>(`/api/agents/${agent.id}/revoke`, {});
  if (final.revocation.onchainPermissionsDisabled !== true)
    throw new Error("P8_REVOKE_REMAINS_UNCONFIRMED");
  const recovery = await browser.api<{ grants: Array<{ hash: Hex; status: string }> }>(
    `/api/agents/${agent.id}/recovery`,
  );
  for (const grant of recovery.grants) {
    if (
      grant.status === "live" ||
      (grant.status === "disabled" && !(await sdk.isDisabled(chain.ctx, grant.hash)))
    )
      throw new Error("P8_DISABLED_STATUS_WITHOUT_CHAIN_CONFIRMATION");
  }
  await chain.finish("a06/revoke", await browser.cachedHashes());
  await browser.page.reload();
  await card.getByText(/Disabled · confirmed receipts/).waitFor({ timeout: 30_000 });
  return {
    checks: [
      "actual Codex OAuth token refused immediately after stop-access",
      "grants remain unconfirmed while revoke route is aborted",
      "Privy owner signs recovery and operator redeems over RPC with all hosted routes blocked",
      "exact earnings sweep confirmed on chain; stable browser operator",
      "restored relay confirms disablement; every disabled status matches chain state",
    ],
    txHashes: [hash, ...(await browser.cachedHashes())],
    details: {
      hostedAccessStopped: true,
      onchainPermissionsDisabled: true,
      token,
      recovered: before.agent.toString(),
      faultInjection: "Playwright network route aborts; no replacement responses",
      gasPayer: agent.operator,
      recoveryGasWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    },
  };
}
