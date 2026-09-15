import { closeSync, ftruncateSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeVisualEvidence,
  MAX_HAR_FILE_BYTES,
} from "../src/tools/analyzeVisualEvidence.js";

const tmp = () => mkdtempSync(join(tmpdir(), "needle-har-"));

const SAMPLE_HAR = {
  log: {
    entries: [
      {
        request: {
          method: "GET",
          url: "https://api.example.com/checkout?token=SECRET123",
          headers: [
            { name: "x-request-id", value: "req-abc123" },
            { name: "Authorization", value: "Bearer super-secret-token" },
            { name: "Cookie", value: "session=leak-me" },
            { name: "X-Custom-Internal", value: "not-allowlisted" },
          ],
        },
        response: { status: 500 },
        time: 1500,
      },
      {
        request: { method: "GET", url: "https://api.example.com/ping", headers: [] },
        response: { status: 200 },
        time: 20,
      },
    ],
  },
};

const fromSample = () => analyzeVisualEvidence({ context: "x", harJson: JSON.stringify(SAMPLE_HAR) });

describe("HAR filtering and redaction", () => {
  it("keeps only failed and slow entries", () => {
    const result = analyzeVisualEvidence({
      context: "checkout failure",
      harJson: JSON.stringify(SAMPLE_HAR),
    });
    expect(result.har_entries).toHaveLength(1);
    expect(result.har_entries[0]!.status).toBe(500);
    expect(result.har_dropped_count).toBe(1);
  });

  it("redacts the URL query string", () => {
    const entry = fromSample().har_entries[0]!;
    expect(entry.url).not.toContain("SECRET123");
    expect(entry.url).toBe("https://api.example.com/checkout");
  });

  it("never returns auth or cookie headers", () => {
    const headers = fromSample().har_entries[0]!.correlation_headers;
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers).not.toHaveProperty("authorization");
    expect(headers).not.toHaveProperty("Cookie");
    expect(headers).not.toHaveProperty("cookie");
  });

  it("drops non-allowlisted headers", () => {
    expect(fromSample().har_entries[0]!.correlation_headers).not.toHaveProperty("X-Custom-Internal");
  });

  it("keeps the correlation header", () => {
    expect(fromSample().har_entries[0]!.correlation_headers["x-request-id"]).toBe("req-abc123");
  });

  it("normalizes a mixed-case correlation header", () => {
    const har = {
      log: {
        entries: [
          {
            request: {
              method: "GET",
              url: "https://api.example.com/x",
              headers: [{ name: "X-Request-Id", value: "req-mixed" }],
            },
            response: { status: 500 },
            time: 10,
          },
        ],
      },
    };
    const result = analyzeVisualEvidence({ context: "x", harJson: JSON.stringify(har) });
    expect(result.har_entries[0]!.correlation_headers["x-request-id"]).toBe("req-mixed");
  });

  it("reads from a file path", () => {
    const p = join(tmp(), "sample.har");
    writeFileSync(p, JSON.stringify(SAMPLE_HAR));
    expect(analyzeVisualEvidence({ context: "x", harPath: p }).har_entries).toHaveLength(1);
  });
});

describe("image passthrough", () => {
  it("passes the image through with a note", () => {
    const result = analyzeVisualEvidence({ context: "x", imageBase64: "ZmFrZWJhc2U2NA==" });
    expect(result.image_passthrough).toBe("ZmFrZWJhc2U2NA==");
    expect(result.notes.some((n) => n.includes("multimodal"))).toBe(true);
  });

  it("returns an empty result with no input", () => {
    const result = analyzeVisualEvidence({ context: "x" });
    expect(result.har_entries).toEqual([]);
    expect(result.image_passthrough).toBeNull();
  });
});

describe("malformed HAR entries do not crash", () => {
  const entry = (overrides: Record<string, unknown>) => ({
    request: { method: "GET", url: "https://api.example.com/a", headers: [] },
    response: { status: 500 },
    time: 10,
    ...overrides,
  });
  const run = (e: unknown) =>
    analyzeVisualEvidence({ context: "x", harJson: JSON.stringify({ log: { entries: [e] } }) });

  it("tolerates a string time", () => {
    expect(run(entry({ response: { status: 200 }, time: "1500" })).har_entries).toHaveLength(1);
  });

  it("tolerates a null time", () => {
    const result = run(entry({ time: null }));
    expect(result.har_entries).toHaveLength(1);
    expect(result.har_entries[0]!.time_ms).toBe(0);
  });

  it("tolerates a string status", () => {
    const result = run(entry({ response: { status: "500" }, time: 100 }));
    expect(result.har_entries[0]!.status).toBe(500);
  });

  it("tolerates a header with no value", () => {
    const result = run(
      entry({ request: { method: "GET", url: "https://a/x", headers: [{ name: "x-request-id" }] } }),
    );
    expect(result.har_entries[0]!.correlation_headers["x-request-id"]).toBe("");
  });

  it("tolerates a header with no name", () => {
    const result = run(
      entry({ request: { method: "GET", url: "https://a/x", headers: [{ value: "orphan" }] } }),
    );
    expect(Object.values(result.har_entries[0]!.correlation_headers)).not.toContain("orphan");
  });

  it("tolerates a missing request", () => {
    const result = run({ response: { status: 500 }, time: 10 });
    expect(result.har_entries).toHaveLength(1);
    expect(result.har_entries[0]!.method).toBe("?");
  });

  it("tolerates a missing response", () => {
    const result = run({
      request: { method: "GET", url: "https://a/x", headers: [] },
      time: 1500,
    });
    expect(result.har_entries).toHaveLength(1);
    expect(result.har_entries[0]!.status).toBe(0);
  });
});

// --- Wall-clock anchor (I1) -------------------------------------------------
//
// time_ms is a DURATION. Without startedDateTime the HAR entry point is the one
// flow that cannot supply the alert_window validateRca then requires every
// evidence row to sit inside.
describe("startedDateTime as the wall-clock anchor", () => {
  const harWith = (started: unknown) => ({
    log: {
      entries: [
        {
          request: { method: "GET", url: "https://api.example.com/x", headers: [] },
          response: { status: 500 },
          time: 10,
          startedDateTime: started,
        },
      ],
    },
  });

  it("carries startedDateTime through as timestamp", () => {
    const result = analyzeVisualEvidence({
      context: "x",
      harJson: JSON.stringify(harWith("2026-09-15T10:00:00.000Z")),
    });
    expect(result.har_entries[0]!.timestamp).toBe("2026-09-15T10:00:00.000Z");
  });

  it("is null when startedDateTime is absent", () => {
    const result = analyzeVisualEvidence({
      context: "x",
      harJson: JSON.stringify({
        log: {
          entries: [
            {
              request: { method: "GET", url: "https://a/x", headers: [] },
              response: { status: 500 },
              time: 10,
            },
          ],
        },
      }),
    });
    expect(result.har_entries[0]!.timestamp).toBeNull();
  });

  it("tolerates a malformed startedDateTime", () => {
    // A non-string value must not throw — this parser guards malformed HARs
    // everywhere else and this field is no exception.
    for (const bad of [12345, [], {}, null, ""]) {
      const result = analyzeVisualEvidence({ context: "x", harJson: JSON.stringify(harWith(bad)) });
      expect(result.har_entries[0]!.timestamp).toBeNull();
    }
  });
});

// --- Structured failure instead of a raw MCP tool error (I2) ----------------
describe("load failures return notes, not exceptions", () => {
  it("reports a missing har_path", () => {
    const result = analyzeVisualEvidence({ context: "x", harPath: "/nonexistent/does-not-exist.har" });
    expect(result.har_entries).toEqual([]);
    expect(result.notes.some((n) => n.includes("does-not-exist.har"))).toBe(true);
  });

  it("reports malformed har_json", () => {
    const result = analyzeVisualEvidence({ context: "x", harJson: '{"log": {"entries": [' });
    expect(result.har_entries).toEqual([]);
    expect(result.notes.some((n) => n.includes("not valid JSON"))).toBe(true);
  });

  it("reports a malformed har file", () => {
    const p = join(tmp(), "truncated.har");
    writeFileSync(p, '{"log": {"entries": [');
    const result = analyzeVisualEvidence({ context: "x", harPath: p });
    expect(result.har_entries).toEqual([]);
    expect(result.notes.some((n) => n.includes("not valid JSON"))).toBe(true);
  });

  it("refuses an oversized har file with a note", () => {
    // Sparse file: statSync reports the full size, and the cap must reject it
    // on size alone, before any read.
    const p = join(tmp(), "big.har");
    const fd = openSync(p, "w");
    ftruncateSync(fd, MAX_HAR_FILE_BYTES + 1);
    closeSync(fd);
    const result = analyzeVisualEvidence({ context: "x", harPath: p });
    expect(result.har_entries).toEqual([]);
    expect(result.notes.some((n) => n.includes("byte cap"))).toBe(true);
  });

  it("keeps the cap generous enough for a real export", () => {
    // Spec §4 anticipates 5-50MB HAR exports; the cap must not undercut that.
    expect(MAX_HAR_FILE_BYTES).toBeGreaterThanOrEqual(50 * 1000 * 1000);
  });

  it("reports HAR input that is not an object", () => {
    const result = analyzeVisualEvidence({ context: "x", harJson: "[1, 2, 3]" });
    expect(result.har_entries).toEqual([]);
    expect(result.notes.some((n) => n.includes("not a HAR document"))).toBe(true);
  });

  it("treats context as optional", () => {
    // SKILL.md and README both document calls that omit context; it is never
    // read by this tool, so requiring it turned those calls into errors.
    expect(analyzeVisualEvidence({ harJson: JSON.stringify(SAMPLE_HAR) }).har_entries).toHaveLength(1);
  });
});
