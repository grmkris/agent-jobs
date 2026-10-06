import { describe, expect, it } from "vitest";
import { factoryAmount, percent, proposalState } from "./stake.ts";

describe("displayed rates", () => {
  it("writes rates as percentages", () => {
    expect([percent(3000), percent(1000), percent(300), percent(100), percent(250)]).toEqual([
      "30 %",
      "10 %",
      "3 %",
      "1 %",
      "2.5 %",
    ]);
  });
});

describe("typed amounts", () => {
  it("reads SIDE in wei and refuses what is not a positive amount", () => {
    expect(factoryAmount("1.5")).toBe(1_500_000_000_000_000_000n);
    expect(factoryAmount("0")).toBeNull();
    expect(factoryAmount("abc")).toBeNull();
    expect(factoryAmount("1.0000000000000000001")).toBeNull();
  });
});

describe("timelocked proposals", () => {
  it("wait for their eta, then stay executable for the grace window, then expire", () => {
    const eta = 1_000_000;
    const grace = 7 * 86_400;
    expect(proposalState(eta, eta - 1, grace)).toBe("waiting");
    expect(proposalState(eta, eta, grace)).toBe("open");
    expect(proposalState(eta, eta + grace, grace)).toBe("open");
    expect(proposalState(eta, eta + grace + 1, grace)).toBe("expired");
  });
});
