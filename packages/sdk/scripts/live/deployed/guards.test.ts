import { describe, expect, it } from "vitest";
import { assertReleased, budgetRemaining, CAP_WEI, publicFailure } from "./guards.ts";
import { providerConfig, toolResult } from "./codex.ts";

describe("deployed fixture boundaries", () => {
  it("requires the exact complete release marker", () => {
    const sha = "a".repeat(40);
    expect(() => assertReleased(sha, `READY ${sha}\n`)).toThrow();
    expect(() => assertReleased(sha.slice(0, 7), `RELEASED ${sha}\n`)).toThrow();
    expect(() => assertReleased(sha, `RELEASED ${"b".repeat(40)}\n`)).toThrow();
    expect(() => assertReleased(sha, `RELEASED ${sha}\n`)).not.toThrow();
  });

  it("counts retained reservations and refuses a total above 2 MON", () => {
    expect(budgetRemaining([{ costWei: "10" }], { pending: "20" })).toBe(CAP_WEI - 30n);
    expect(() => budgetRemaining([{ costWei: CAP_WEI.toString() }], { pending: "1" })).toThrow();
    expect(() => budgetRemaining([{ costWei: "-1" }], {})).toThrow();
  });

  it("copies only the selected provider tables into isolated Codex config", () => {
    const config = providerConfig(
      'model_provider = "fixture"\n[mcp_servers.private]\nurl = "hidden"\n[model_providers.fixture]\nenv_key = "FIXTURE_KEY"\nbase_url = "http://127.0.0.1:8317/v1"\n[features]\nshell_tool = true\n',
    );
    expect(config.envKey).toBe("FIXTURE_KEY");
    expect(config.toml).toContain("[model_providers.fixture]");
    expect(config.toml).not.toContain("hidden");
    expect(config.toml).not.toContain("shell_tool");
  });

  it("requires actual MCP events with identical frozen arguments", () => {
    const args = { operationKey: "fixture-key", taskId: "fixture-job" };
    const event = JSON.stringify({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "hireling",
        tool: "apply",
        arguments: { taskId: "fixture-job", operationKey: "fixture-key" },
        result: { content: [{ type: "text", text: '{"ok":true}' }] },
      },
    });
    expect(toolResult(event, "apply", args).output).toEqual({ ok: true });
    expect(() => toolResult(event, "apply", { ...args, operationKey: "changed" })).toThrow();
    expect(() =>
      toolResult(
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done" } }),
        "apply",
        args,
      ),
    ).toThrow();
    expect(() =>
      toolResult(
        `${event}\n${JSON.stringify({ type: "item.completed", item: { type: "command_execution" } })}`,
        "apply",
        args,
      ),
    ).toThrow();
  });

  it("never exposes raw provider, wallet or browser errors", () => {
    expect(publicFailure(new Error("token=private email=fixture@example.invalid"))).toBe(
      "P8_SCENARIO_FAILED_DETAILS_SUPPRESSED",
    );
    expect(publicFailure(new Error("P8_WRONG_CHAIN"))).toBe("P8_WRONG_CHAIN");
  });
});
