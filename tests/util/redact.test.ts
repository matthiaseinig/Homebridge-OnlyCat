import { describe, expect, it } from "vitest";
import { redactToken } from "../../src/util/redact.js";

describe("redactToken", () => {
  it("returns <missing> for empty input", () => {
    expect(redactToken(undefined)).toBe("<missing>");
    expect(redactToken(null)).toBe("<missing>");
    expect(redactToken("")).toBe("<missing>");
  });

  it("returns *** for very short tokens", () => {
    expect(redactToken("abc")).toBe("***");
    expect(redactToken("abcd")).toBe("***");
  });

  it("returns first 4 chars + *** for longer tokens", () => {
    expect(redactToken("FakeTok123")).toBe("Fake***");
    expect(redactToken("0123456789abcdef")).toBe("0123***");
  });
});
