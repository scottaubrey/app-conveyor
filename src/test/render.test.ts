import { test, expect } from "bun:test";
import { renderDashboard, renderPackageDetail } from "../render";
import type { Package, PipelineConfig } from "../types";

const cfg: PipelineConfig = {
  steps: [
    { id: "src", type: "git",  repo: "my-org/app", branch: "main" },
    { id: "ci",  type: "gha",  workflow: "deploy.yaml" },
    { id: "reg", type: "ghcr", image: "ghcr.io/my-org/app" },
  ],
};

function makePkg(overrides: Partial<Package> = {}): Package {
  return {
    id: "abc1234abc1234abc1234abc1234abc1234abc123",
    commitHash: "abc1234abc1234abc1234abc1234abc1234abc123",
    repoFullName: "my-org/app",
    branch: "main",
    authorName: "Dev",
    message: "feat: add feature",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentStep: 1,
    steps: [
      { stepId: "src", status: "passed",  label: "abc1234", updatedAt: new Date().toISOString(), commitHash: "abc1234abc1234abc1234abc1234abc1234abc123" },
      { stepId: "ci",  status: "running", label: "#123456", updatedAt: new Date().toISOString() },
      { stepId: "reg", status: "pending", label: "…",       updatedAt: new Date().toISOString() },
    ],
    ...overrides,
  };
}

test("renderDashboard produces valid HTML with column headers", () => {
  const html = renderDashboard([makePkg()], cfg, new Date("2025-01-01T12:00:00Z"));
  expect(html).toContain("<!DOCTYPE html>");
  expect(html).toContain("ARTIFACT CONVEYOR");
  expect(html).toContain("COMMIT");
  expect(html).toContain("RUN");
  expect(html).toContain("DIGEST");
});

test("renderDashboard shows the commit short hash", () => {
  const html = renderDashboard([makePkg()], cfg, new Date());
  expect(html).toContain("abc1234");
});

test("renderDashboard shows empty state when no packages", () => {
  const html = renderDashboard([], cfg, new Date());
  expect(html).toContain("No packages tracked yet");
});

test("renderDashboard renders step statuses as badge text", () => {
  const html = renderDashboard([makePkg()], cfg, new Date());
  expect(html).toContain("PASS");  // src step
  expect(html).toContain("RUN");   // ci step
  expect(html).toContain("WAIT");  // reg step
});

test("renderDashboard escapes HTML in commit messages", () => {
  const pkg = makePkg({ message: "<script>alert('xss')</script>" });
  const html = renderDashboard([pkg], cfg, new Date());
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});

test("renderPackageDetail includes step history", () => {
  const pkg = makePkg();
  const history = [
    { step_id: "ci", status: "running", label: "#123", detail: "in progress", recorded_at: "2025-01-01T10:00:00Z" },
    { step_id: "ci", status: "passed",  label: "#123", detail: "done",        recorded_at: "2025-01-01T10:05:00Z" },
  ];
  const html = renderPackageDetail(pkg, history);
  expect(html).toContain("abc1234");
  expect(html).toContain("running");
  expect(html).toContain("passed");
  expect(html).toContain("in progress");
});
