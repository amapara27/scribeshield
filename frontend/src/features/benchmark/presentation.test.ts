import { describe, expect, it } from "vitest";
import { formatPercent } from "@/features/benchmark/presentation";

describe("formatPercent", () => {
  it("formats ratio values as percentages", () => {
    expect(formatPercent(0.249)).toBe("24.9%");
    expect(formatPercent(0.02)).toBe("2.0%");
  });

  it("preserves values already expressed as percentages", () => {
    expect(formatPercent(24.9)).toBe("24.9%");
    expect(formatPercent(37)).toBe("37.0%");
  });
});
