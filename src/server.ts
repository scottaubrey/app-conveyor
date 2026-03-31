import type { PipelineConfig } from "./types";
import { listPackages, getPackage, getStepHistory, upsertPackage, upsertStepState } from "./db";
import { renderDashboard, renderPackageDetail } from "./render";
import { now } from "./util";

export function createServer(cfg: PipelineConfig, triggerPoll?: () => Promise<void>) {
  const port = Number(process.env.PORT ?? 3000);

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // GET / — main dashboard
      if (path === "/" || path === "") {
        const packages = listPackages(50);
        const html = renderDashboard(packages, cfg, new Date());
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // GET /package/:id — detail view
      const detailMatch = path.match(/^\/package\/([a-f0-9]{7,40})$/);
      if (detailMatch && detailMatch[1]) {
        const id = detailMatch[1];
        // Accept short hashes — find full match
        const pkg = findPackageByPrefix(id);
        if (!pkg) {
          return new Response("Package not found", { status: 404 });
        }
        const history: any[] = [];
        for (const step of pkg.steps) {
          history.push(...getStepHistory(pkg.id, step.stepId));
        }
        const html = renderPackageDetail(pkg, history);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // POST /api/sync — trigger an immediate poll then redirect to dashboard
      if (path === "/api/sync" && req.method === "POST") {
        if (triggerPoll) {
          await triggerPoll();
        }
        return new Response(null, { status: 303, headers: { Location: "/" } });
      }

      // POST /api/ingest — manual ingestion endpoint
      if (path === "/api/ingest" && req.method === "POST") {
        return handleIngest(req, cfg);
      }

      // GET /api/packages — JSON list
      if (path === "/api/packages") {
        const packages = listPackages(50);
        return Response.json(packages);
      }

      // GET /healthz
      if (path === "/healthz") {
        return new Response("ok");
      }

      return new Response("Not found", { status: 404 });
    },
    error(err) {
      console.error("[server] unhandled error:", err);
      return new Response("Internal server error", { status: 500 });
    },
  });

  console.log(`[server] listening on http://localhost:${port}`);
  return server;
}

function findPackageByPrefix(prefix: string) {
  const packages = listPackages(200);
  return packages.find(p => p.id.startsWith(prefix)) ?? null;
}

async function handleIngest(req: Request, cfg: PipelineConfig): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { commit_hash, repo, branch, author, message } = body;
  if (!commit_hash || typeof commit_hash !== "string") {
    return new Response("commit_hash required", { status: 400 });
  }

  const existing = getPackage(commit_hash);
  if (existing) {
    return Response.json({ ok: true, created: false, id: commit_hash });
  }

  const gitStep = cfg.steps.find(s => s.type === "git");

  upsertPackage({
    id: commit_hash,
    commitHash: commit_hash,
    repoFullName: repo ?? gitStep?.repo ?? "unknown/repo",
    branch: branch ?? gitStep?.branch ?? "main",
    authorName: author,
    message,
    createdAt: now(),
    updatedAt: now(),
    currentStep: 0,
  });

  // Seed git step as passed
  if (gitStep) {
    upsertStepState(commit_hash, {
      stepId: gitStep.id,
      status: "passed",
      label: commit_hash.slice(0, 7),
      detail: message,
      updatedAt: now(),
      commitHash: commit_hash,
    });
  }

  // Seed remaining steps as pending
  for (const s of cfg.steps.filter(s => s.type !== "git")) {
    upsertStepState(commit_hash, {
      stepId: s.id,
      status: "pending",
      label: "…",
      updatedAt: now(),
    });
  }

  return Response.json({ ok: true, created: true, id: commit_hash });
}
