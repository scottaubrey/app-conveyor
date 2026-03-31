import { test, expect, mock, beforeEach } from "bun:test";

// Use in-memory DB
process.env.DB_PATH = ":memory:";

const { upsertPackage, upsertStepState, getPackage, listPackages } = await import("../db");
const { Engine } = await import("../engine");
import type { PipelineConfig, StepState } from "../types";

// Minimal config: one git step + one gha step
const cfg: PipelineConfig = {
  pollIntervalMs: 999_999,
  steps: [
    { id: "src", type: "git",  repo: "my-org/app", branch: "main" },
    { id: "ci",  type: "gha",  repo: "my-org/app", workflow: "deploy.yaml" },
  ],
};

const SHA = "eeee000000000000000000000000000000000001";

function seedPackage() {
  upsertPackage({
    id: SHA, commitHash: SHA, repoFullName: "my-org/app", branch: "main",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), currentStep: 0,
  });
  upsertStepState(SHA, { stepId: "src", status: "passed", label: "eeee000", updatedAt: new Date().toISOString(), commitHash: SHA });
  upsertStepState(SHA, { stepId: "ci",  status: "pending", label: "…",      updatedAt: new Date().toISOString() });
}

test("engine advances a pending GHA step to passed", async () => {
  seedPackage();

  // Mock fetch to return a successful workflow run
  globalThis.fetch = mock(async (url: string) => {
    if (String(url).includes("/actions/workflows/")) {
      return new Response(JSON.stringify({
        workflow_runs: [{ id: 42, status: "completed", conclusion: "success" }],
      }));
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as any;

  const engine = new Engine(cfg);
  // Bypass git discovery by calling advancePackages directly
  await (engine as any).advancePackages();

  const pkg = getPackage(SHA)!;
  const ciStep = pkg.steps.find(s => s.stepId === "ci");
  expect(ciStep?.status).toBe("passed");
  expect(ciStep?.ghaRunId).toBe("42");
});

test("engine marks step as failed on API error", async () => {
  seedPackage();

  globalThis.fetch = mock(async () => {
    throw new Error("network timeout");
  }) as any;

  const engine = new Engine(cfg);
  await (engine as any).advancePackages();

  const pkg = getPackage(SHA)!;
  const ciStep = pkg.steps.find(s => s.stepId === "ci");
  expect(ciStep?.status).toBe("failed");
  expect(ciStep?.detail).toContain("network timeout");
});

test("engine skips already-passed steps", async () => {
  seedPackage();
  // Mark ci as already passed
  upsertStepState(SHA, { stepId: "ci", status: "passed", label: "done", updatedAt: new Date().toISOString() });

  let fetchCalled = false;
  globalThis.fetch = mock(async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({ workflow_runs: [] }));
  }) as any;

  const engine = new Engine(cfg);
  await (engine as any).advancePackages();

  // fetch should not have been called because ci is already passed
  expect(fetchCalled).toBe(false);
});

test("gatherUpstream collects IDs from existing steps", () => {
  const steps: StepState[] = [
    { stepId: "src", status: "passed", label: "abc", updatedAt: new Date().toISOString(), commitHash: SHA },
    { stepId: "ci",  status: "passed", label: "#42", updatedAt: new Date().toISOString(), ghaRunId: "42" },
  ];
  const engine = new Engine(cfg);
  const upstream = (engine as any).gatherUpstream(steps);
  expect(upstream.commitHash).toBe(SHA);
  expect(upstream.ghaRunId).toBe("42");
});
