import { randomUUID } from "node:crypto";
import * as sdk from "../../../src/index.ts";
import { ORIGIN, required } from "./guards.ts";
import { type ManagedAgent } from "./browser.ts";
import { Runtime, type Proof } from "./runtime.ts";

async function readAgent(runtime: Runtime, id: string): Promise<ManagedAgent> {
  const { agents } = await runtime.browser.api<{ agents: ManagedAgent[] }>("/api/agents");
  const agent = agents.find((row) => row.id === id);
  if (agent === undefined) throw new Error("P8_FIXTURE_AGENT_NOT_FOUND");
  return agent;
}

/** All setup uses the actual site's controls and the Privy test session. */
export async function onboarding(runtime: Runtime): Promise<Proof> {
  await runtime.login();
  const { run, chain, browser } = runtime;
  const operator = await browser.operator();
  const draft =
    run.get<{ id: string; name: string }>("agent-draft") ??
    run.set("agent-draft", {
      id: randomUUID(),
      name: `P8 fixture ${run.get<string>("run-id")!}`,
    });
  const records = await browser.api<{ agents: ManagedAgent[] }>("/api/agents");
  let agent = records.agents.find((row) => row.id === draft.id);
  if (agent === undefined) {
    // Use the app's own documented draft journal before creation, so a killed browser
    // returns to the same create request rather than creating another wallet.
    await browser.page.evaluate(
      ({ owner, intent }) => {
        const storage = (
          globalThis as unknown as { localStorage: { setItem(key: string, value: string): void } }
        ).localStorage;
        storage.setItem(`sidequest.agent-draft:${owner}`, JSON.stringify(intent));
      },
      { owner: operator, intent: draft },
    );
    await browser.page.goto(`${ORIGIN}/agents/new`);
    await browser.page.getByRole("textbox", { name: "Agent name", exact: true }).fill(draft.name);
    const response = browser.page.waitForResponse(
      (reply) =>
        new URL(reply.url()).pathname === "/api/agents" && reply.request().method() === "POST",
    );
    await browser.click("Create agent wallet", { key: "onboarding/create", gas: 200_000n });
    if (!(await response).ok()) throw new Error("P8_CREATE_AGENT_REFUSED");
    agent = await readAgent(runtime, draft.id);
    run.set("managed-agent", agent);
    if (agent.address === null) throw new Error("P8_CREATE_AGENT_HAS_NO_WALLET");
    chain.addActor(agent.address);
    await chain.finish("onboarding/create", await browser.cachedHashes());
  } else {
    run.set("managed-agent", agent);
    // Setup resumes on the agent's page once it has an Agent ID, at /agents/new?resume=<id> before.
    await browser.page.goto(
      agent.agent_id === null
        ? `${ORIGIN}/agents/new?resume=${encodeURIComponent(agent.id)}`
        : `${ORIGIN}/agent/${agent.agent_id}?tab=manage`,
    );
  }
  if (agent.state === "created" || agent.state === "upgraded") {
    const response = browser.page.waitForResponse(
      (reply) => new URL(reply.url()).pathname === `/api/agents/${draft.id}/resume`,
    );
    await browser.click("Resume wallet setup", { key: "onboarding/resume", gas: 200_000n });
    if (!(await response).ok()) throw new Error("P8_AGENT_RESUME_REFUSED");
    agent = await readAgent(runtime, draft.id);
    run.set("managed-agent", agent);
    await chain.finish("onboarding/resume", await browser.cachedHashes());
  }
  if (agent.state !== "active") {
    const continueButton = browser.page.getByRole("button", {
      name: "Continue with gas sponsorship enabled",
      exact: true,
    });
    const reviewOperator = browser.page.getByRole("button", {
      name: "Review operator permission",
      exact: true,
    });
    await browser.page
      .getByText(/gas sponsorship for your operator|Continue with gas sponsorship enabled/)
      .first()
      .waitFor();
    if (await continueButton.isVisible()) await continueButton.click();
    else {
      await reviewOperator.click();
      await browser.click("Upgrade and sign operator permission", {
        key: "onboarding/operator",
        gas: 200_000n,
      });
      await browser.page
        .getByRole("button", { name: "Review registration grant", exact: true })
        .waitFor({ timeout: 60_000 });
      await chain.finish("onboarding/operator", await browser.cachedHashes());
    }
    await browser.click("Review registration grant");
    const response = browser.page.waitForResponse(
      (reply) => new URL(reply.url()).pathname === `/api/agents/${draft.id}/registration-confirm`,
    );
    await browser.click("Sign registration permission", {
      key: "onboarding/register",
      gas: 1_200_000n,
    });
    if (!(await response).ok()) throw new Error("P8_AGENT_REGISTRATION_REFUSED");
    agent = await readAgent(runtime, draft.id);
    run.set("managed-agent", agent);
    if (agent.state !== "active") throw new Error("P8_REGISTRATION_PENDING_RETRY_ORIGINAL_DRAFT");
    await chain.finish("onboarding/register", await browser.cachedHashes());
  }
  if (
    agent.address === null ||
    agent.agent_id === null ||
    agent.address.toLowerCase() === operator.toLowerCase()
  )
    throw new Error("P8_AGENT_BINDING_INCOMPLETE");
  chain.addActor(agent.address);
  const [owner, wallet] = await Promise.all([
    chain.ctx.publicClient.readContract({
      address: chain.ctx.deployment.identity,
      abi: sdk.identityAbi,
      functionName: "ownerOf",
      args: [BigInt(agent.agent_id)],
    }),
    sdk.agentWallet(chain.ctx, BigInt(agent.agent_id)),
  ]);
  if (
    owner.toLowerCase() !== operator.toLowerCase() ||
    wallet.toLowerCase() !== agent.address.toLowerCase() ||
    (await browser.operator()).toLowerCase() !== operator.toLowerCase()
  )
    throw new Error("P8_REGISTRY_OR_OPERATOR_MISMATCH");
  if (agent.privy_wallet_id === null || !agent.privy_user_id)
    throw new Error("P8_PROVIDER_BINDING_UNAVAILABLE");
  const provider = new sdk.PrivyServer({
    appId: required("PRIVY_APP_ID"),
    appSecret: required("PRIVY_APP_SECRET"),
    sign: async () => {
      throw new Error("P8_ONBOARDING_IS_PROVIDER_READ_ONLY");
    },
  });
  const verified = await provider.verifyAgentWallet(
    agent.privy_wallet_id,
    agent.privy_user_id,
    required("PRIVY_SIGNER_ID"),
    required("PRIVY_POLICY_ID"),
  );
  if (verified.address.toLowerCase() !== agent.address.toLowerCase())
    throw new Error("P8_PRIVY_WALLET_MISMATCH");
  run.set("managed-agent", agent);
  return {
    checks: [
      "real Privy fixture login and browser-created managed agent",
      "registry owner is the stable operator",
      "agentWallet is the separate managed wallet",
      "Privy user ownership, routine signer and policy read back",
    ],
    txHashes: await browser.cachedHashes(),
    details: { operator, agent: agent.address, agentId: agent.agent_id, managedAgentId: agent.id },
  };
}
