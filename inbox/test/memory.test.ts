// The memory service answers /context with plain strings; inbox works with {file, content} / MemoryEvent.
import { describe, expect, it } from "vitest";
import { contextToText, normalizeContext } from "../src/memory.js";

describe("normalizeContext", () => {
  it("converts the memory service's string items", () => {
    const ctx = normalizeContext({
      snippets: ["Maya emailed Prof. Lee"],
      knowledge: ["people.md: - Prof. Lee: CS61B instructor\n- Sam: recruiter", "umem: likes tea", "no file prefix here"],
    });
    expect(ctx.knowledge).toEqual([
      { file: "people.md", content: "- Prof. Lee: CS61B instructor\n- Sam: recruiter" },
      { file: "memory", content: "no file prefix here" },
    ]);
    expect(ctx.umem).toBe("likes tea");
    expect(ctx.snippets[0]).toMatchObject({ kind: "observation", text: "Maya emailed Prof. Lee" });
    expect(contextToText(ctx)).toContain("## people.md");
  });
  it("passes object-shaped items through and survives junk", () => {
    const ctx = normalizeContext({ snippets: [{ ts: "t", agent: "inbox", source: "gmail", kind: "task", text: "x" }, 5], knowledge: [{ file: "a.md", content: "c" }, null] });
    expect(ctx.knowledge).toEqual([{ file: "a.md", content: "c" }]);
    expect(ctx.snippets).toHaveLength(1);
    expect(normalizeContext(undefined)).toEqual({ snippets: [], knowledge: [] });
  });
});
