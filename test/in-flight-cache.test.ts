import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  CURRENT_IN_FLIGHT_SCHEMA_VERSION,
  cleanupStaleInFlight,
  fitArtifactToIndexBudget,
  INDEX_BYTE_BUDGET,
  IndexRecordSchema,
  inFlightDir,
  readAllTasks,
  readIndex,
  readPrompt,
  readTask,
  TaskRecordSchema,
  taskId,
  writeIndex,
  writePrompt,
  writeTask,
  type IndexRecord,
  type TaskRecord,
} from "../src/cache/in-flight.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lenses-in-flight-test-"));
  process.env.LENSES_IN_FLIGHT_DIR = dir;
});
afterAll(() => {
  delete process.env.LENSES_IN_FLIGHT_DIR;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  // Clean between tests so each starts from a known empty dir.
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";

function makeIndex(overrides: Partial<IndexRecord> = {}): IndexRecord {
  return {
    schemaVersion: CURRENT_IN_FLIGHT_SCHEMA_VERSION,
    reviewId: RID,
    sessionId: SID,
    stage: "PLAN_REVIEW",
    expectedLensIds: ["security", "clean-code"],
    reviewRound: 1,
    priorDeferrals: [],
    createdAt: new Date().toISOString(),
    // T-026 R9: artifact + changedFiles are defaulted in IndexRecordSchema
    // but required on the inferred OUTPUT type, so the fixture must supply
    // them or `npm run typecheck` fails and the roundtrip toEqual breaks.
    artifact: "",
    changedFiles: [],
    cachedResults: {},
    lensMeta: {
      security: {
        model: "opus",
        promptHash: "h-security",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      "clean-code": {
        model: "sonnet",
        promptHash: "h-clean",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
    ...overrides,
  };
}

function makeTask(
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  const lensId = overrides.lensId ?? "security";
  const attempt = overrides.attempt ?? 1;
  return {
    schemaVersion: CURRENT_IN_FLIGHT_SCHEMA_VERSION,
    taskId: taskId(RID, lensId, attempt),
    reviewId: RID,
    lensId,
    attempt,
    status: "pending",
    promptHash: "h-" + lensId,
    chunkIndex: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    errorCode: null,
    lensOutput: null,
    ...overrides,
  };
}

describe("fitArtifactToIndexBudget (T-026 R7 / pen res 4)", () => {
  const MAX_FILE_BYTES = 10 * 1024 * 1024;

  it("returns an under-budget record unchanged (reference identity)", () => {
    const rec = makeIndex({ artifact: "small diff" });
    expect(fitArtifactToIndexBudget(rec)).toBe(rec);
  });

  it("fits an oversized plain artifact under the read gate and it rehydrates", () => {
    const rec = makeIndex({ artifact: "x".repeat(MAX_FILE_BYTES + 1000) });
    const fitted = fitArtifactToIndexBudget(rec);
    const bytes = Buffer.byteLength(JSON.stringify(fitted), "utf8");
    expect(bytes).toBeLessThanOrEqual(INDEX_BYTE_BUDGET);
    writeIndex(fitted);
    const back = readIndex(RID);
    expect(back).toBeDefined();
    expect(back!.artifact.length).toBeLessThan(rec.artifact.length);
  });

  it("fits an escape-heavy (control-character) artifact under budget and rehydrates", () => {
    // Each control char serializes to \u00XX (6 bytes), so ~2M chars overflow.
    const rec = makeIndex({ artifact: "\u0001".repeat(2_000_000) });
    const fitted = fitArtifactToIndexBudget(rec);
    const bytes = Buffer.byteLength(JSON.stringify(fitted), "utf8");
    expect(bytes).toBeLessThanOrEqual(INDEX_BYTE_BUDGET);
    writeIndex(fitted);
    expect(readIndex(RID)).toBeDefined();
  });

  it("fits a multibyte artifact under budget without splitting a code point", () => {
    // Astral code points are 2 UTF-16 units / 4 UTF-8 bytes each.
    const rec = makeIndex({ artifact: "\u{1F600}".repeat(3_000_000) });
    const fitted = fitArtifactToIndexBudget(rec);
    const bytes = Buffer.byteLength(JSON.stringify(fitted), "utf8");
    expect(bytes).toBeLessThanOrEqual(INDEX_BYTE_BUDGET);
    // No lone surrogate left at the tail: re-encoding round-trips cleanly.
    expect(Buffer.from(fitted.artifact, "utf8").toString("utf8")).toBe(
      fitted.artifact,
    );
    writeIndex(fitted);
    expect(readIndex(RID)).toBeDefined();
  });
});

describe("inFlightDir", () => {
  it("creates the directory if missing and returns the path", () => {
    rmSync(dir, { recursive: true, force: true });
    const resolved = inFlightDir();
    expect(resolved).toBe(dir);
    expect(statSync(resolved).isDirectory()).toBe(true);
  });
});

describe("writeIndex / readIndex", () => {
  it("roundtrips an IndexRecord", () => {
    const idx = makeIndex();
    writeIndex(idx);
    expect(readIndex(RID)).toEqual(idx);
  });

  it("readIndex returns undefined when the file is missing", () => {
    expect(readIndex("not-a-real-review")).toBeUndefined();
  });

  it("rejects a record missing required fields at write time", () => {
    expect(() =>
      writeIndex({ reviewId: RID } as unknown as IndexRecord),
    ).toThrow();
  });

  it("atomic rename: no .tmp leftovers after a successful write", () => {
    writeIndex(makeIndex());
    const files = readdirSync(join(dir, RID));
    expect(files).toContain("index.json");
    for (const f of files) {
      expect(f.startsWith(".tmp-")).toBe(false);
    }
  });
});

describe("writePrompt / readPrompt", () => {
  it("roundtrips the prompt text verbatim", () => {
    const prompt = "## Safety\n\nBe careful.\n\nLens: security\n";
    writePrompt({ reviewId: RID, lensId: "security", prompt });
    expect(readPrompt(RID, "security")).toBe(prompt);
  });

  it("returns undefined on a missing prompt file", () => {
    expect(readPrompt(RID, "never-registered")).toBeUndefined();
  });
});

describe("writeTask / readTask", () => {
  it("roundtrips a TaskRecord", () => {
    const task = makeTask();
    writeTask(task);
    expect(readTask(RID, "security", 1)).toEqual(task);
  });

  it("later-attempt task overwrites same (lensId, attempt) file; different attempts coexist", () => {
    writeTask(makeTask({ attempt: 1, status: "completed" }));
    writeTask(makeTask({ attempt: 2, status: "failed", errorCode: "PARSE_FAILURE" }));
    expect(readTask(RID, "security", 1)?.status).toBe("completed");
    expect(readTask(RID, "security", 2)?.status).toBe("failed");
    expect(readTask(RID, "security", 2)?.errorCode).toBe("PARSE_FAILURE");
  });

  it("TaskRecordSchema rejects a record with a bad status value", () => {
    expect(() =>
      TaskRecordSchema.parse({ ...makeTask(), status: "bogus" }),
    ).toThrow();
  });

  it("IndexRecordSchema rejects a record without lensMeta", () => {
    expect(() =>
      IndexRecordSchema.parse({ ...makeIndex(), lensMeta: undefined }),
    ).toThrow();
  });
});

describe("readAllTasks", () => {
  it("returns the HIGHEST-attempt record per lens", () => {
    writeTask(makeTask({ lensId: "security", attempt: 1, status: "failed" }));
    writeTask(makeTask({ lensId: "security", attempt: 2, status: "completed" }));
    writeTask(makeTask({ lensId: "clean-code", attempt: 1, status: "pending" }));
    const tasks = readAllTasks(RID);
    expect(tasks.get("security")?.attempt).toBe(2);
    expect(tasks.get("security")?.status).toBe("completed");
    expect(tasks.get("clean-code")?.attempt).toBe(1);
  });

  it("returns an empty map for an unknown reviewId", () => {
    const tasks = readAllTasks("no-such-review");
    expect(tasks.size).toBe(0);
  });
});

describe("cleanupStaleInFlight", () => {
  it("removes review dirs whose index.json.createdAt is older than maxAgeMs", () => {
    const fresh = makeIndex({
      reviewId: "33333333-3333-4333-8333-333333333333",
      createdAt: new Date().toISOString(),
    });
    const stale = makeIndex({
      reviewId: "44444444-4444-4444-8444-444444444444",
      createdAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    });
    writeIndex(fresh);
    writeIndex(stale);
    const result = cleanupStaleInFlight(60 * 60 * 1000); // 1h
    expect(result.removed).toBe(1);
    expect(readIndex(stale.reviewId)).toBeUndefined();
    expect(readIndex(fresh.reviewId)).toBeDefined();
  });
});
