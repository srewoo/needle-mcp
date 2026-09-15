import { describe, expect, it } from "vitest";
import {
  assertHostAllowed,
  assertUrlStructureUnchanged,
  HostNotAllowedError,
  redactHeaders,
  redactUrl,
  safeEncodeParam,
} from "../src/security.js";

describe("redactHeaders", () => {
  it("keeps allowlisted headers", () => {
    expect(redactHeaders({ "X-Request-Id": "abc", "Content-Type": "application/json" })).toEqual({
      "X-Request-Id": "abc",
      "Content-Type": "application/json",
    });
  });

  it("drops non-allowlisted headers", () => {
    const out = redactHeaders({ "X-Request-Id": "abc", "X-Custom-Internal": "secret-shape" });
    expect(out).toEqual({ "X-Request-Id": "abc" });
  });

  it("never returns auth headers even if explicitly allowlisted", () => {
    const out = redactHeaders(
      { Authorization: "Bearer xyz", Cookie: "session=abc" },
      ["authorization", "cookie"],
    );
    expect(out).toEqual({});
  });
});

describe("redactUrl", () => {
  it("strips the query string", () => {
    expect(redactUrl("https://api.example.com/checkout?token=secret&user=alice")).toBe(
      "https://api.example.com/checkout",
    );
  });

  it("drops embedded userinfo rather than echoing credentials", () => {
    expect(redactUrl("https://user:hunter2@api.example.com/x?a=1")).toBe(
      "https://api.example.com/x",
    );
  });

  it("does not throw on a malformed URL", () => {
    expect(redactUrl("not a url at all?x=1")).toBe("not a url at all");
  });
});

describe("assertHostAllowed", () => {
  it("passes for an allowed host", () => {
    expect(() =>
      assertHostAllowed("https://loki.example.internal/api", ["loki.example.internal"]),
    ).not.toThrow();
  });

  it("throws for a disallowed host", () => {
    expect(() => assertHostAllowed("https://evil.example.com/api", ["loki.example.internal"])).toThrow(
      HostNotAllowedError,
    );
  });
});

describe("safeEncodeParam", () => {
  it("encodes a normal value", () => {
    expect(safeEncodeParam("checkout service")).toBe("checkout%20service");
  });

  it("allows a URL-valued query, encoded inert", () => {
    // Searching logs FOR a URL is a core RCA query and must not be rejected.
    const encoded = safeEncodeParam("https://api.example.com/checkout");
    expect(encoded).not.toContain("://");
    expect(encoded).toBe("https%3A%2F%2Fapi.example.com%2Fcheckout");
  });

  it("allows dots in range syntax", () => {
    // ES range syntax and version strings contain '..'; an encoded value cannot
    // escape its query-string position anyway. A throw here would be the regression.
    expect(safeEncodeParam("latency..500")).toBe("latency..500");
  });

  it("matches Python quote(safe='') on characters encodeURIComponent leaves alone", () => {
    expect(safeEncodeParam("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
  });

  it("rejects a protocol-relative value", () => {
    expect(() => safeEncodeParam("//attacker.com/steal")).toThrow();
  });
});

describe("assertUrlStructureUnchanged", () => {
  it("passes for the same host", () => {
    expect(() =>
      assertUrlStructureUnchanged(
        "https://loki.example.internal/api/q?x=1",
        "https://loki.example.internal",
      ),
    ).not.toThrow();
  });

  it("rejects a host swap", () => {
    expect(() =>
      assertUrlStructureUnchanged("https://evil.example.com/api/q", "https://loki.example.internal"),
    ).toThrow(HostNotAllowedError);
  });

  it("rejects a scheme downgrade", () => {
    expect(() =>
      assertUrlStructureUnchanged(
        "http://loki.example.internal/api/q",
        "https://loki.example.internal",
      ),
    ).toThrow(HostNotAllowedError);
  });

  it("redacts the query string in the error on a host swap", () => {
    // The message must not leak a query string that may carry tokens/PII.
    let message = "";
    try {
      assertUrlStructureUnchanged(
        "https://evil.example.com/api/q?token=secret-abc123",
        "https://loki.example.internal",
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("token=secret-abc123");
    expect(message).toContain("evil.example.com/api/q");
  });

  it("rejects a '..' path segment", () => {
    // The base-path startsWith check is a no-op for bare-host base_urls (every
    // shipped adapter), so this concrete check must reject traversal regardless.
    expect(() =>
      assertUrlStructureUnchanged(
        "https://loki.example.internal/api/../admin/q",
        "https://loki.example.internal",
      ),
    ).toThrow(HostNotAllowedError);
  });
});
