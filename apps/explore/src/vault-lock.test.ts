import { describe, expect, it } from "vitest";
import { clearOwnedIntent, withVaultIntentLock } from "./vault-lock.ts";

describe("vault intent lock", () => {
  it("serialises two tabs and rereads the shared pointer before preparing", async () => {
    let held = false;
    const queue: Array<() => void> = [];
    const locks = {
      request: async (_name: string, work: () => Promise<void>) => {
        if (held) await new Promise<void>((resolve) => queue.push(resolve));
        held = true;
        try {
          await work();
        } finally {
          held = false;
          queue.shift()?.();
        }
      },
    };
    const intents: string[] = [];
    let pointer: { id: string } | null = null;
    const prepare = (id: string) =>
      withVaultIntentLock(locks, "vault:owner:agent", async () => {
        if (pointer !== null) throw new Error("saved intent already exists");
        await Promise.resolve();
        pointer = { id };
        intents.push(id);
      });
    await Promise.allSettled([prepare("first"), prepare("second")]);
    expect(intents).toEqual(["first"]);
  });

  it("clears only the intent the completing tab created", () => {
    const map = new Map<string, string>([["k", JSON.stringify({ id: "new" })]]);
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      removeItem: (key: string) => map.delete(key),
    };
    expect(clearOwnedIntent(storage, "k", "old")).toBe(false);
    expect(map.has("k")).toBe(true);
    expect(clearOwnedIntent(storage, "k", "new")).toBe(true);
    expect(map.has("k")).toBe(false);
  });
});
