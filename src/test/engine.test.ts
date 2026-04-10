import { expect, mock, test } from "bun:test";

// Use in-memory DB
process.env.DB_PATH = ":memory:";

const { upsertPackage, upsertStepState, getPackage } = await import("../db");
const { Engine } = await import("../engine");

import type { PipelineConfig, StepState } from "../types";

const PIPELINE = "test-pipeline";

// Minimal config: one git step + one gha step
const cfg: PipelineConfig = {
  id: PIPELINE,
  name: "Test Pipeline",
  pollIntervalMs: 999_999,
  steps: [
    { id: "src", type: "git", repo: "my-org/app", branch: "main" },
    { id: "ci", type: "gha", repo: "my-org/app", workflow: "deploy.yaml" },
  ],
};

const SHA = "eeee000000000000000000000000000000000001";
const PKG_ID = `${PIPELINE}:${SHA}`;

function seedPackage() {
  upsertPackage({
    id: PKG_ID,
    pipelineId: PIPELINE,
    commitHash: SHA,
    repoFullName: "my-org/app",
    branch: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentStep: 0,
    status: "active",
  });
  upsertStepState(PKG_ID, {
    stepId: "src",
    status: "passed",
    label: "eeee000",
    updatedAt: new Date().toISOString(),
    commitHash: SHA,
  });
  upsertStepState(PKG_ID, {
    stepId: "ci",
    status: "pending",
    label: "…",
    updatedAt: new Date().toISOString(),
  });
}

test("engine advances a pending GHA step to passed", async () => {
  seedPackage();

  globalThis.fetch = mock(async (url: string) => {
    if (String(url).includes("/actions/workflows/")) {
      return new Response(
        JSON.stringify({
          workflow_runs: [
            { id: 42, status: "completed", conclusion: "success" },
          ],
        }),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof globalThis.fetch;

  const engine = new Engine(cfg);
  await (
    engine as unknown as { advancePackages(): Promise<void> }
  ).advancePackages();

  const pkg = getPackage(PKG_ID);
  if (!pkg) throw new Error("expected package");
  const ciStep = pkg.steps.find((s) => s.stepId === "ci");
  expect(ciStep?.status).toBe("passed");
  expect(ciStep?.ghaRunId).toBe("42");
});

test("engine marks step as failed on API error", async () => {
  seedPackage();

  globalThis.fetch = mock(async () => {
    throw new Error("network timeout");
  }) as unknown as typeof globalThis.fetch;

  const engine = new Engine(cfg);
  await (
    engine as unknown as { advancePackages(): Promise<void> }
  ).advancePackages();

  const pkg = getPackage(PKG_ID);
  if (!pkg) throw new Error("expected package");
  const ciStep = pkg.steps.find((s) => s.stepId === "ci");
  expect(ciStep?.status).toBe("failed");
  expect(ciStep?.detail).toContain("network timeout");
});

test("engine skips already-passed steps", async () => {
  seedPackage();
  upsertStepState(PKG_ID, {
    stepId: "ci",
    status: "passed",
    label: "done",
    updatedAt: new Date().toISOString(),
  });

  let fetchCalled = false;
  globalThis.fetch = mock(async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({ workflow_runs: [] }));
  }) as unknown as typeof globalThis.fetch;

  const engine = new Engine(cfg);
  await (
    engine as unknown as { advancePackages(): Promise<void> }
  ).advancePackages();

  expect(fetchCalled).toBe(false);
});

test("advancePackages supersedes older active packages once a newer one fully passes", async () => {
  // Older package — active, stuck at ci step, created in the past.
  const OLD_SHA = "ffff000000000000000000000000000000000001";
  const OLD_PKG = `${PIPELINE}:${OLD_SHA}`;
  upsertPackage({
    id: OLD_PKG,
    pipelineId: PIPELINE,
    commitHash: OLD_SHA,
    repoFullName: "my-org/app",
    branch: "main",
    createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
    currentStep: 0,
    status: "active",
  });
  upsertStepState(OLD_PKG, {
    stepId: "src",
    status: "passed",
    label: "ffff000",
    updatedAt: "2000-01-01T00:00:00.000Z",
    commitHash: OLD_SHA,
  });
  upsertStepState(OLD_PKG, {
    stepId: "ci",
    status: "running",
    label: "…",
    updatedAt: "2000-01-01T00:00:00.000Z",
  });

  // Newer package — will complete all steps in this poll.
  seedPackage();

  // GHA: return in_progress for the old package's SHA, success for the new one.
  globalThis.fetch = mock(async (url: string) => {
    if (String(url).includes("/actions/workflows/")) {
      if (String(url).includes(OLD_SHA.slice(0, 7))) {
        return new Response(
          JSON.stringify({ workflow_runs: [{ id: 1, status: "in_progress" }] }),
        );
      }
      return new Response(
        JSON.stringify({
          workflow_runs: [
            { id: 42, status: "completed", conclusion: "success" },
          ],
        }),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof globalThis.fetch;

  const engine = new Engine(cfg);
  await (
    engine as unknown as { advancePackages(): Promise<void> }
  ).advancePackages();

  // Newer package fully passed → complete.
  const newPkg = getPackage(PKG_ID);
  if (!newPkg) throw new Error("expected new package");
  expect(newPkg.status).toBe("complete");

  // Older package superseded — no longer polled.
  const oldPkg = getPackage(OLD_PKG);
  if (!oldPkg) throw new Error("expected old package");
  expect(oldPkg.status).toBe("superseded");
  const ciStep = oldPkg.steps.find((s) => s.stepId === "ci");
  expect(ciStep?.status).toBe("skipped");
  expect(ciStep?.detail).toBe("superseded by newer deployment");
});

test("gatherUpstream collects IDs from existing steps", () => {
  const steps: StepState[] = [
    {
      stepId: "src",
      status: "passed",
      label: "abc",
      updatedAt: new Date().toISOString(),
      commitHash: SHA,
    },
    {
      stepId: "ci",
      status: "passed",
      label: "#42",
      updatedAt: new Date().toISOString(),
      ghaRunId: "42",
    },
  ];
  const engine = new Engine(cfg);
  const upstream = (
    engine as unknown as {
      gatherUpstream(steps: StepState[]): Record<string, string>;
    }
  ).gatherUpstream(steps);
  expect(upstream.commitHash).toBe(SHA);
  expect(upstream.ghaRunId).toBe("42");
});
