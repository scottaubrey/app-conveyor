import { expect, test } from "bun:test";

// Override DB_PATH to use an in-memory database for tests
process.env.DB_PATH = ":memory:";

// Must import AFTER setting DB_PATH so the module picks it up fresh
const {
  upsertPackage,
  upsertStepState,
  getPackage,
  listPackages,
  getStepHistory,
  listActivePackages,
  resetPackage,
  supersedeBefore,
} = await import("../db");

const PIPELINE = "test-pipeline";

function freshPkg(id = "abc1234abc1234abc1234abc1234abc1234abc123") {
  return {
    id,
    pipelineId: PIPELINE,
    commitHash: id,
    repoFullName: "my-org/my-app",
    branch: "main",
    authorName: "Dev",
    message: "chore: bump version",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentStep: 0,
    status: "active" as const,
  };
}

test("upsertPackage creates a new row", () => {
  upsertPackage(freshPkg());
  const pkg = getPackage("abc1234abc1234abc1234abc1234abc1234abc123");
  expect(pkg).not.toBeNull();
  expect(pkg?.commitHash).toBe("abc1234abc1234abc1234abc1234abc1234abc123");
  expect(pkg?.repoFullName).toBe("my-org/my-app");
});

test("upsertPackage is idempotent", () => {
  const id = "aaaa000000000000000000000000000000000001";
  upsertPackage(freshPkg(id));
  upsertPackage(freshPkg(id)); // second call should not throw
  const all = listPackages(PIPELINE);
  expect(all.filter((p) => p.id === id).length).toBe(1);
});

test("upsertStepState creates and updates step", () => {
  const id = "bbbb000000000000000000000000000000000001";
  upsertPackage(freshPkg(id));

  upsertStepState(id, {
    stepId: "src",
    status: "passed",
    label: "abc1234",
    updatedAt: new Date().toISOString(),
    commitHash: id,
  });

  const pkg = getPackage(id);
  if (!pkg) throw new Error("expected package");
  const step = pkg.steps[0];
  if (!step) throw new Error("expected step");
  expect(pkg.steps.length).toBe(1);
  expect(step.status).toBe("passed");
  expect(step.commitHash).toBe(id);
});

test("upsertStepState records history on status change", () => {
  const id = "cccc000000000000000000000000000000000001";
  upsertPackage(freshPkg(id));

  const base = {
    stepId: "ci",
    label: "run",
    updatedAt: new Date().toISOString(),
  };
  upsertStepState(id, { ...base, status: "running" });
  upsertStepState(id, { ...base, status: "passed" });
  upsertStepState(id, { ...base, status: "passed" }); // duplicate — should not add history

  const hist = getStepHistory(id, "ci");
  expect(hist.length).toBe(2); // running → passed
  expect(hist[0]?.status).toBe("passed");
  expect(hist[1]?.status).toBe("running");
});

test("listPackages returns most recent first", () => {
  const ids = [
    "dddd000000000000000000000000000000000001",
    "dddd000000000000000000000000000000000002",
  ];
  const base = new Date("2025-01-01T00:00:00Z");
  upsertPackage({
    ...freshPkg(ids[0]),
    createdAt: new Date(base.getTime() + 1000).toISOString(),
    updatedAt: new Date().toISOString(),
  });
  upsertPackage({
    ...freshPkg(ids[1]),
    createdAt: new Date(base.getTime() + 2000).toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const list = listPackages(PIPELINE);
  const idxA = list.findIndex((p) => p.id === ids[0]);
  const idxB = list.findIndex((p) => p.id === ids[1]);
  expect(idxB).toBeLessThan(idxA); // newer first
});

test("getPackage returns null for unknown id", () => {
  expect(getPackage("0000000000000000000000000000000000000000")).toBeNull();
});

// ─── resetPackage ─────────────────────────────────────────────────────────────

const RESET_ID = "eeee100000000000000000000000000000000001";

function seedForReset() {
  upsertPackage(freshPkg(RESET_ID));
  // git step (preserved)
  upsertStepState(RESET_ID, {
    stepId: "src",
    status: "passed",
    label: "eeee100",
    updatedAt: new Date().toISOString(),
    commitHash: RESET_ID,
  });
  // downstream steps
  upsertStepState(RESET_ID, {
    stepId: "ci",
    status: "passed",
    label: "#1",
    updatedAt: new Date().toISOString(),
  });
  upsertStepState(RESET_ID, {
    stepId: "deploy",
    status: "failed",
    label: "err",
    detail: "timeout",
    updatedAt: new Date().toISOString(),
  });
}

test("resetPackage resets non-git steps to pending", () => {
  seedForReset();
  resetPackage(RESET_ID, ["src"]);
  const pkg = getPackage(RESET_ID);
  if (!pkg) throw new Error("expected package");
  const src = pkg.steps.find((s) => s.stepId === "src");
  const ci = pkg.steps.find((s) => s.stepId === "ci");
  const deploy = pkg.steps.find((s) => s.stepId === "deploy");
  expect(src?.status).toBe("passed"); // git step untouched
  expect(ci?.status).toBe("pending");
  expect(deploy?.status).toBe("pending");
});

test("resetPackage records history for status changes", () => {
  const id = "eeee200000000000000000000000000000000001";
  upsertPackage(freshPkg(id));
  upsertStepState(id, {
    stepId: "ci",
    status: "failed",
    label: "err",
    updatedAt: new Date().toISOString(),
  });
  resetPackage(id, []);
  const hist = getStepHistory(id, "ci");
  expect(hist[0]?.status).toBe("pending"); // most recent entry
});

test("resetPackage with newSnapshot marks orphaned steps skipped", () => {
  const id = "eeee300000000000000000000000000000000001";
  upsertPackage(freshPkg(id));
  upsertStepState(id, {
    stepId: "src",
    status: "passed",
    label: "eeee300",
    updatedAt: new Date().toISOString(),
  });
  upsertStepState(id, {
    stepId: "ci",
    status: "passed",
    label: "#2",
    updatedAt: new Date().toISOString(),
  });
  upsertStepState(id, {
    stepId: "old-step",
    status: "failed",
    label: "err",
    updatedAt: new Date().toISOString(),
  });

  const newConfig = {
    id: PIPELINE,
    name: "Test Pipeline",
    steps: [
      { id: "src", type: "git" as const, repo: "org/app", branch: "main" },
      { id: "ci", type: "gha" as const, repo: "org/app", workflow: "ci.yaml" },
      // old-step removed
    ],
  };

  resetPackage(id, ["src"], newConfig);
  const pkg = getPackage(id);
  if (!pkg) throw new Error("expected package");
  const ci = pkg.steps.find((s) => s.stepId === "ci");
  const oldStep = pkg.steps.find((s) => s.stepId === "old-step");
  expect(ci?.status).toBe("pending");
  expect(oldStep?.status).toBe("skipped");
  expect(oldStep?.detail).toBe("step removed from pipeline config");
});

test("resetPackage with newSnapshot updates config_snapshot", () => {
  const id = "eeee400000000000000000000000000000000001";
  upsertPackage(freshPkg(id));
  const newConfig = {
    id: PIPELINE,
    name: "Updated Pipeline",
    steps: [
      { id: "src", type: "git" as const, repo: "org/app", branch: "main" },
    ],
  };
  resetPackage(id, ["src"], newConfig);
  const pkg = getPackage(id);
  expect(pkg?.configSnapshot?.name).toBe("Updated Pipeline");
});

// ─── supersedeBefore ─────────────────────────────────────────────────────────

// Each test uses its own pipeline ID so packages don't bleed between tests.
const T_OLD = "2000-01-01T00:00:00.000Z";
const T_MID = "2000-06-01T00:00:00.000Z";
const T_NEW = "2001-01-01T00:00:00.000Z";

function superPkg(
  pipelineId: string,
  suffix: string,
  createdAt: string,
  status: "active" | "complete" | "superseded" = "active",
) {
  const id = `ffff${suffix}`;
  upsertPackage({
    id,
    pipelineId,
    commitHash: id,
    repoFullName: "org/app",
    branch: "main",
    createdAt,
    updatedAt: createdAt,
    currentStep: 0,
    status,
  });
  return id;
}

test("supersedeBefore returns 0 when no complete package exists", () => {
  const pl = "sup-1";
  const id = superPkg(pl, "000000000000000000000000000000000001", T_OLD);
  upsertStepState(id, {
    stepId: "ci",
    status: "running",
    label: "…",
    updatedAt: T_OLD,
  });

  expect(supersedeBefore(pl)).toBe(0);
  expect(getPackage(id)?.status).toBe("active");
});

test("supersedeBefore returns 0 when newest complete package has a failed step", () => {
  const pl = "sup-2";
  const oldId = superPkg(pl, "000000000000000000000000000000000002", T_OLD);
  const newId = superPkg(
    pl,
    "000000000000000000000000000000000003",
    T_NEW,
    "complete",
  );
  upsertStepState(oldId, {
    stepId: "ci",
    status: "running",
    label: "…",
    updatedAt: T_OLD,
  });
  upsertStepState(newId, {
    stepId: "ci",
    status: "failed",
    label: "err",
    updatedAt: T_NEW,
  });

  expect(supersedeBefore(pl)).toBe(0);
  expect(getPackage(oldId)?.status).toBe("active");
});

test("supersedeBefore supersedes active packages older than the anchor", () => {
  const pl = "sup-3";
  const oldId = superPkg(pl, "000000000000000000000000000000000004", T_OLD);
  const newId = superPkg(
    pl,
    "000000000000000000000000000000000005",
    T_NEW,
    "complete",
  );
  upsertStepState(oldId, {
    stepId: "ci",
    status: "running",
    label: "…",
    updatedAt: T_OLD,
  });
  upsertStepState(newId, {
    stepId: "ci",
    status: "passed",
    label: "ok",
    updatedAt: T_NEW,
  });

  expect(supersedeBefore(pl)).toBe(1);
  expect(getPackage(oldId)?.status).toBe("superseded");
  const ci = getPackage(oldId)?.steps.find((s) => s.stepId === "ci");
  expect(ci?.status).toBe("skipped");
  expect(ci?.detail).toBe("superseded by newer deployment");
});

test("supersedeBefore does not supersede active packages newer than the anchor", () => {
  const pl = "sup-4";
  const oldId = superPkg(
    pl,
    "000000000000000000000000000000000006",
    T_OLD,
    "complete",
  );
  const newId = superPkg(pl, "000000000000000000000000000000000007", T_NEW);
  upsertStepState(oldId, {
    stepId: "ci",
    status: "passed",
    label: "ok",
    updatedAt: T_OLD,
  });
  upsertStepState(newId, {
    stepId: "ci",
    status: "running",
    label: "…",
    updatedAt: T_NEW,
  });

  expect(supersedeBefore(pl)).toBe(0);
  expect(getPackage(newId)?.status).toBe("active");
});

test("supersedeBefore records step history for superseded steps", () => {
  const pl = "sup-5";
  const oldId = superPkg(pl, "000000000000000000000000000000000008", T_OLD);
  const newId = superPkg(
    pl,
    "000000000000000000000000000000000009",
    T_NEW,
    "complete",
  );
  upsertStepState(oldId, {
    stepId: "ci",
    status: "pending",
    label: "…",
    updatedAt: T_OLD,
  });
  upsertStepState(newId, {
    stepId: "ci",
    status: "passed",
    label: "ok",
    updatedAt: T_NEW,
  });

  supersedeBefore(pl);

  const hist = getStepHistory(oldId, "ci");
  const entry = hist.find((h) => h.status === "skipped");
  expect(entry).toBeDefined();
  expect(entry?.detail).toBe("superseded by newer deployment");
});

test("supersedeBefore does not touch already-complete packages", () => {
  const pl = "sup-6";
  const doneId = superPkg(
    pl,
    "00000000000000000000000000000000000a0",
    T_MID,
    "complete",
  );
  const newId = superPkg(
    pl,
    "00000000000000000000000000000000000b0",
    T_NEW,
    "complete",
  );
  upsertStepState(doneId, {
    stepId: "ci",
    status: "failed",
    label: "err",
    updatedAt: T_MID,
  });
  upsertStepState(newId, {
    stepId: "ci",
    status: "passed",
    label: "ok",
    updatedAt: T_NEW,
  });

  expect(supersedeBefore(pl)).toBe(0); // complete packages are not in the active set
  expect(getPackage(doneId)?.status).toBe("complete");
});
