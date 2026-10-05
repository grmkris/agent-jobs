import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ORIGIN } from "./guards.ts";
import { Runtime, type Proof } from "./runtime.ts";

export async function clients(runtime: Runtime): Promise<Proof> {
  await runtime.login();
  const client = await runtime.coding("fresh");
  const result = await client.call("get_instructions", { role: "connector" }, "a08-instructions");
  if (
    result.item.result?.isError === true ||
    typeof result.output !== "string" ||
    !result.output.includes("operationKey") ||
    !result.output.includes("not worker liveness")
  )
    throw new Error("P8_FRESH_INSTRUCTIONS_MISSING");
  await runtime.browser.page.goto(`${ORIGIN}/agent/${runtime.agent.agent_id}?tab=manage`);
  const card = runtime.browser.page.locator("article").filter({ hasText: runtime.agent.name });
  await card.getByText(/Last activity:/).waitFor({ timeout: 30_000 });
  if (!/Last activity:[\s\S]*not a health signal/i.test(await card.innerText()))
    throw new Error("P8_LAST_ACTIVITY_IS_LIVENESS");
  await promisify(execFile)("heavy", ["bun", "test", "scripts/mining"], { timeout: 180_000 });
  return {
    checks: [
      "fresh isolated Codex client retrieves connector instructions",
      "Last activity explicitly disclaims liveness",
      "bun test scripts/mining passes",
    ],
    txHashes: [],
    details: {
      client: "fresh Codex with independent OAuth credentials",
      mining: "heavy bun test scripts/mining",
    },
  };
}
