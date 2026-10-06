/** Real Privy policy probes on the wallet created through the deployed service. */
import { generateKeyPairSync } from "node:crypto";
import * as sdk from "../../../src/index.ts";
import { PrivyApi } from "../../privy/client.ts";
import { schema, signingShapes } from "../../privy/policy.ts";
import { required } from "./guards.ts";
import { Runtime, type Proof } from "./runtime.ts";

interface Denial {
  probe: string;
  enforcementLayer: "provider-policy" | "provider-authorization" | "hosted-application";
  path: "Privy API with routine quorum" | "deployed MCP" | "deployed HTTP";
  status?: number;
  code: string;
}

export async function policyDenials(runtime: Runtime): Promise<Proof> {
  await runtime.login();
  const agent = runtime.agent;
  if (agent.privy_wallet_id === null) throw new Error("P8_PROVIDER_WALLET_BINDING_MISSING");
  const api = new PrivyApi(required("PRIVY_APP_ID"), required("PRIVY_APP_SECRET"));
  const sign = await sdk.p256AuthorizationSigner(required("PRIVY_SIGNER_KEY"));
  const provider = new sdk.PrivyServer({
    appId: required("PRIVY_APP_ID"),
    appSecret: required("PRIVY_APP_SECRET"),
    sign,
  });
  await provider.verifyAgentWallet(
    agent.privy_wallet_id,
    agent.privy_user_id,
    required("PRIVY_SIGNER_ID"),
    required("PRIVY_POLICY_ID"),
  );
  const shape = signingShapes.find((item) => item.primaryType === "SetBudgetAuthorization")!;
  const baseline = {
    method: "eth_signTypedData_v4",
    params: {
      typed_data: {
        ...schema(shape),
        domain: {
          name: shape.name,
          version: "1",
          chainId: 10143,
          verifyingContract: shape.contract,
        },
        message: {
          signer: agent.address,
          jobId: "0",
          token: runtime.chain.ctx.deployment.rewardTokens[0],
          amount: "0",
          optParamsHash: sdk.EMPTY_HASH,
          nonce: "0",
          deadline: String(Math.floor(Date.now() / 1000) + 600),
        },
      },
    },
  };
  const wrongChain = structuredClone(baseline);
  wrongChain.params.typed_data.domain.chainId = 143;
  const wrongDomain = structuredClone(baseline);
  wrongDomain.params.typed_data.domain.verifyingContract = runtime.chain.ctx.deployment.relay;
  const wrongType = structuredClone(baseline);
  wrongType.params.typed_data.primary_type = "UnapprovedAuthorization";
  wrongType.params.typed_data.types = {
    EIP712Domain: baseline.params.typed_data.types.EIP712Domain!,
    UnapprovedAuthorization: baseline.params.typed_data.types.SetBudgetAuthorization!,
  };
  const wrongField = structuredClone(baseline);
  wrongField.params.typed_data.message.signer = agent.operator;
  const delegation = signingShapes.find((item) => item.primaryType === "Delegation")!;
  const wrongDelegate = {
    method: "eth_signTypedData_v4",
    params: {
      typed_data: {
        ...schema(delegation),
        domain: {
          name: delegation.name,
          version: "1",
          chainId: 10143,
          verifyingContract: delegation.contract,
        },
        message: {
          delegate: agent.operator,
          delegator: agent.address,
          authority: sdk.ROOT_AUTHORITY,
          caveats: [],
          salt: "0",
        },
      },
    },
  };
  const results: Denial[] = [];
  for (const [probe, body] of [
    ["wrong chain", wrongChain],
    ["wrong verifying contract", wrongDomain],
    ["wrong type", wrongType],
    ["wrong signer field", wrongField],
    ["wrong delegate", wrongDelegate],
  ] as const) {
    const response = await api.request(
      "POST",
      `/wallets/${agent.privy_wallet_id}/rpc`,
      body,
      sign,
      `p8-${runtime.run.get<string>("run-id")}-${probe.replaceAll(" ", "-")}`,
    );
    results.push({
      probe,
      enforcementLayer: "provider-policy",
      path: "Privy API with routine quorum",
      status: response.status,
      code: response.code,
    });
    if (response.status < 400 || response.status >= 500 || !response.code.includes("policy"))
      throw new Error("P8_PROVIDER_POLICY_DENIAL_NOT_PROVEN");
  }
  const policyId = required("PRIVY_POLICY_ID");
  const beforePolicy = await api.checked("GET", `/policies/${policyId}`);
  const beforeWallet = await api.checked("GET", `/wallets/${agent.privy_wallet_id}`);
  for (const [probe, route, body] of [
    ["policy update", `/policies/${policyId}`, { name: beforePolicy.name }],
    [
      "signer update",
      `/wallets/${agent.privy_wallet_id}`,
      { additional_signers: beforeWallet.additional_signers },
    ],
  ] as const) {
    const response = await api.request("PATCH", route, body, sign);
    results.push({
      probe,
      enforcementLayer: "provider-authorization",
      path: "Privy API with routine quorum",
      status: response.status,
      code: response.code,
    });
    if (response.status !== 401 && response.status !== 403)
      throw new Error("P8_ROUTINE_AUTHORITY_MUTATION_NOT_DENIED");
  }
  const afterPolicy = await api.checked("GET", `/policies/${policyId}`);
  const afterWallet = await api.checked("GET", `/wallets/${agent.privy_wallet_id}`);
  if (
    JSON.stringify(beforePolicy) !== JSON.stringify(afterPolicy) ||
    JSON.stringify(beforeWallet.additional_signers) !==
      JSON.stringify(afterWallet.additional_signers)
  )
    throw new Error("P8_POLICY_OR_SIGNERS_CHANGED");
  const publicKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64");
  const exported = await api.request(
    "POST",
    `/wallets/${agent.privy_wallet_id}/export`,
    { encryption_type: "HPKE", recipient_public_key: publicKey },
    sign,
  );
  results.push({
    probe: "export",
    enforcementLayer: "provider-authorization",
    path: "Privy API with routine quorum",
    status: exported.status,
    code: exported.code,
  });
  if (exported.status !== 401 && exported.status !== 403)
    throw new Error("P8_ROUTINE_EXPORT_AUTHORIZATION_NOT_DENIED");
  const coding = await runtime.coding();
  const job = runtime.run.get<{ taskId: string }>("a02/job");
  if (job === undefined) throw new Error("P8_POLICY_REQUIRES_A02_JOB");
  const refused = await coding.call(
    "apply",
    {
      taskId: job.taskId,
      agentId: `${BigInt(agent.agent_id!) + 1n}`,
      operationKey: `p8:${runtime.run.runId}:a05-wrong-agent`,
    },
    "a05-wrong-agent",
  );
  if (
    refused.item.result?.isError !== true ||
    !JSON.stringify(refused.output).includes("registered agentId")
  )
    throw new Error("P8_DEPLOYED_SIGNER_SCOPE_DENIAL_NOT_PROVEN");
  results.push({
    probe: "another registered identity",
    enforcementLayer: "hosted-application",
    path: "deployed MCP",
    code: "registered_agent_scope",
  });
  const grantRefusal = await runtime.browser.page.evaluate(
    async ({ id }) => {
      const storage = (globalThis as unknown as { localStorage: Storage }).localStorage;
      const response = await fetch(`/api/agents/${id}/execute`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${storage.getItem("sidequest.session")}`,
        },
        body: JSON.stringify({
          tool: "sign_grant",
          operationKey: "p8-forbidden-grant",
          args: { caveats: [] },
        }),
      });
      const json = (await response.json()) as { ok?: boolean; code?: string };
      return { status: response.status, ok: json.ok, code: json.code };
    },
    { id: agent.id },
  );
  if (grantRefusal.ok !== false || grantRefusal.code !== "forbidden")
    throw new Error("P8_ARBITRARY_CAVEAT_SIGNING_EXPOSED");
  results.push({
    probe: "arbitrary signing tool with empty caveats",
    enforcementLayer: "hosted-application",
    path: "deployed HTTP",
    status: grantRefusal.status,
    code: grantRefusal.code,
  });
  return {
    checks: [
      ...results.map((item) => `${item.enforcementLayer}: ${item.probe} refused`),
      "provider-authorization: policy and signers unchanged after refused mutations",
    ],
    txHashes: [],
    details: {
      results,
      boundary:
        "Provider probes use the deployed-created wallet and routine quorum directly. The MCP identity refusal and HTTP arbitrary-signing-tool refusal are hosted application evidence. Exact caveat and domain-version validation remains source/fork evidence; this suite uses no raw signing endpoint.",
    },
  };
}
