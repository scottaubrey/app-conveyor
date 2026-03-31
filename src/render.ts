import type { Package, StepState, StepConfig, PipelineConfig } from "./types";
import { relativeTime } from "./util";

// ─── Status helpers ────────────────────────────────────────────────────────

const STATUS_CLASS: Record<string, string> = {
  passed: "passed",
  failed: "failed",
  running: "running",
  pending: "pending",
  skipped: "skipped",
};

const STATUS_LABEL: Record<string, string> = {
  passed: "Pass",
  failed: "Fail",
  running: "Run",
  pending: "Wait",
  skipped: "Skip",
};

const STEP_TYPE_LABEL: Record<string, string> = {
  git: "Commit",
  gha: "Build",
  ghcr: "Image Ready",
  "flux-image": "Flux Update",
  "flux-kustomize": "Flux Sync",
  "k8s-deploy": "Deploy Ready",
};

function stepLabel(type: string): string {
  return STEP_TYPE_LABEL[type] ?? type;
}

// ─── CSS ──────────────────────────────────────────────────────────────────

const CSS = `
:root {
  --bg: #0d1117;
  --surface: #161b22;
  --border: #30363d;
  --text: #e6edf3;
  --muted: #8b949e;
  --passed: #3fb950;
  --failed: #f85149;
  --running: #d29922;
  --pending: #388bfd;
  --skipped: #6e7681;
  --connector: #30363d;
  font-size: 13px;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  padding: 1.5rem;
  min-height: 100vh;
}

header {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  margin-bottom: 1.5rem;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.75rem;
}

header h1 { font-size: 1rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
header .subtitle { color: var(--muted); font-size: 0.8rem; }
header .refresh-hint { margin-left: auto; color: var(--muted); font-size: 0.75rem; }

.sync-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
  font-family: inherit;
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.sync-btn:hover { border-color: #58a6ff; color: #58a6ff; }
.sync-btn:disabled { opacity: 0.5; cursor: default; }

/* ── Belt header (step column labels) ── */
.belt-header {
  display: grid;
  gap: 0;
  margin-bottom: 0.5rem;
  padding: 0 0.5rem;
}

.belt-col-label {
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
  text-align: center;
  padding: 0.25rem 0;
}

/* ── Package card row ── */
.package-row {
  display: grid;
  gap: 0;
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 0.5rem;
  overflow: hidden;
  transition: border-color 0.2s;
}

.package-row:hover { border-color: #58a6ff; }

.pkg-meta {
  padding: 0.5rem 0.75rem;
  border-right: 1px solid var(--border);
  min-width: 0;
}

.pkg-meta .commit { font-size: 0.75rem; font-weight: 700; color: #58a6ff; }
.pkg-meta .msg {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
  font-size: 0.75rem;
  margin-top: 0.15rem;
}
.pkg-meta .age { color: var(--muted); font-size: 0.65rem; margin-top: 0.15rem; }

/* ── Step cell ── */
.step-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0.5rem 0.25rem;
  border-right: 1px solid var(--border);
  cursor: default;
  min-width: 0;
  height: 100%;
}

.step-cell:last-child { border-right: none; }

/* Connector arrow between cells */
.step-cell::before {
  content: '';
  position: absolute;
  left: -1px;
  top: 50%;
  transform: translateY(-50%);
  width: 0;
  height: 0;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-left: 7px solid var(--bg);
  z-index: 1;
  pointer-events: none;
}

.step-cell:first-of-type::before { display: none; }

.step-badge {
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.15rem 0.4rem;
  border-radius: 3px;
  border: 1px solid transparent;
}

.step-value {
  font-size: 0.7rem;
  color: var(--muted);
  margin-top: 0.2rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
  text-align: center;
}

/* Status colours */
.passed .step-badge  { background: rgba(63,185,80,0.15);  border-color: var(--passed);  color: var(--passed);  }
.failed .step-badge  { background: rgba(248,81,73,0.15);   border-color: var(--failed);  color: var(--failed);  }
.running .step-badge { background: rgba(210,153,34,0.15);  border-color: var(--running); color: var(--running); }
.pending .step-badge { background: rgba(56,139,253,0.12);  border-color: var(--pending); color: var(--pending); }
.skipped .step-badge { background: transparent;            border-color: var(--skipped); color: var(--skipped); }

/* Active cell highlight */
.step-cell.active-step::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(88,166,255,0.04);
  pointer-events: none;
}

/* Tooltip */
.step-cell[title]:hover::after {
  content: attr(title);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: #1c2128;
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 0.7rem;
  padding: 0.4rem 0.6rem;
  border-radius: 4px;
  white-space: pre;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  z-index: 10;
  pointer-events: none;
}

.empty-state {
  text-align: center;
  color: var(--muted);
  padding: 3rem;
  font-size: 0.85rem;
}

footer {
  margin-top: 2rem;
  color: var(--muted);
  font-size: 0.7rem;
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
  display: flex;
  gap: 1rem;
}
`;

// ─── Grid template helper ─────────────────────────────────────────────────

function gridTemplate(stepCount: number): string {
  // Meta column: fixed 200px, then equal-width step columns
  return `grid-template-columns: 200px repeat(${stepCount}, 1fr)`;
}

// ─── Main render ──────────────────────────────────────────────────────────

export function renderDashboard(
  packages: Package[],
  cfg: PipelineConfig,
  now: Date
): string {
  const steps = cfg.steps.filter(s => s.type !== "git");
  const grid = gridTemplate(steps.length);

  const headerCols = steps.map(s => `
    <div class="belt-col-label">${stepLabel(s.type)}</div>
  `).join("");

  const rows = packages.length === 0
    ? `<div class="empty-state">No packages tracked yet. Waiting for first commit…</div>`
    : packages.map(pkg => renderPackageRow(pkg, steps, grid)).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>App Conveyor</title>
  <style>${CSS}</style>
</head>
<body>
  <header>
    <h1>App Conveyor</h1>
    <span class="subtitle">${steps[0] ? (steps[0] as any).repo ?? "" : ""}</span>
    <span class="refresh-hint">auto-refresh 30s &middot; ${now.toISOString().slice(11, 19)} UTC</span>
    <form method="POST" action="/api/sync" style="margin:0">
      <button class="sync-btn" type="submit">SYNC NOW</button>
    </form>
  </header>

  <div class="belt-header" style="${grid}">
    <div></div>
    ${headerCols}
  </div>

  <div class="belt-rows">
    ${rows}
  </div>

  <footer>
    <span>${packages.length} package(s) tracked</span>
    <span>App Conveyor &mdash; Bun.js SSR</span>
  </footer>
</body>
</html>`;
}

function renderPackageRow(pkg: Package, steps: StepConfig[], grid: string): string {
  const stepMap = new Map(pkg.steps.map(s => [s.stepId, s]));
  const age = relativeTime(pkg.createdAt);
  const shortCommit = pkg.commitHash.slice(0, 7);
  const msgTrunc = (pkg.message ?? "").slice(0, 48);

  const stepCells = steps.map((cfg, idx) => {
    const state = stepMap.get(cfg.id);
    if (!state) {
      return `<div class="step-cell pending" title="not yet initialized">
        <span class="step-badge">Wait</span>
        <span class="step-value">…</span>
      </div>`;
    }

    const cls = STATUS_CLASS[state.status] ?? "pending";
    const badge = STATUS_LABEL[state.status] ?? state.status.toUpperCase();
    const tooltip = [
      `${stepLabel(cfg.type)} [${cfg.id}]`,
      `status: ${state.status}`,
      state.detail ? `\n${state.detail}` : "",
      `\nupdated: ${state.updatedAt.slice(0, 19).replace("T", " ")}`,
    ].filter(Boolean).join(" ");

    const isActive = state.status === "running";

    return `<div class="step-cell ${cls}${isActive ? " active-step" : ""}" title="${escHtml(tooltip)}">
      <span class="step-badge">${badge}</span>
      <span class="step-value">${escHtml(state.label)}</span>
    </div>`;
  }).join("");

  return `<div class="package-row" style="${grid}">
    <div class="pkg-meta">
      <div class="commit">${shortCommit}</div>
      <div class="msg" title="${escHtml(pkg.message ?? "")}">${escHtml(msgTrunc)}</div>
      <div class="age">${age} &middot; ${escHtml(pkg.branch)}</div>
    </div>
    ${stepCells}
  </div>`;
}

export function renderPackageDetail(pkg: Package, history: any[]): string {
  const rows = pkg.steps.map(s => {
    const hist = history.filter(h => h.step_id === s.stepId);
    const histRows = hist.map(h => `
      <tr>
        <td>${h.recorded_at.slice(0, 19).replace("T", " ")}</td>
        <td class="${STATUS_CLASS[h.status] ?? ''}">${h.status}</td>
        <td>${escHtml(h.label)}</td>
        <td>${escHtml(h.detail ?? "")}</td>
      </tr>
    `).join("");

    return `
      <section class="step-detail">
        <h3>${escHtml(s.stepId)} <span class="badge ${STATUS_CLASS[s.status]}">${s.status}</span></h3>
        <p class="detail-text">${escHtml(s.detail ?? "")}</p>
        ${hist.length > 0 ? `
        <table class="hist-table">
          <thead><tr><th>Time</th><th>Status</th><th>Label</th><th>Detail</th></tr></thead>
          <tbody>${histRows}</tbody>
        </table>` : ""}
      </section>
    `;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${pkg.commitHash.slice(0, 7)} — App Conveyor</title>
  <style>
    ${CSS}
    .step-detail { border: 1px solid var(--border); border-radius: 6px; padding: 1rem; margin-bottom: 1rem; background: var(--surface); }
    .step-detail h3 { font-size: 0.85rem; margin-bottom: 0.4rem; }
    .detail-text { color: var(--muted); font-size: 0.75rem; margin-bottom: 0.5rem; white-space: pre-wrap; word-break: break-all; }
    .hist-table { width: 100%; border-collapse: collapse; font-size: 0.72rem; }
    .hist-table th, .hist-table td { padding: 0.3rem 0.5rem; border: 1px solid var(--border); text-align: left; }
    .hist-table th { color: var(--muted); }
    .badge { font-size: 0.6rem; padding: 0.1rem 0.3rem; border-radius: 3px; margin-left: 0.4rem; vertical-align: middle; }
    .badge.passed { background: rgba(63,185,80,0.15); color: var(--passed); }
    .badge.failed { background: rgba(248,81,73,0.15); color: var(--failed); }
    .badge.running { background: rgba(210,153,34,0.15); color: var(--running); }
    .badge.pending { background: rgba(56,139,253,0.12); color: var(--pending); }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <header>
    <h1><a href="/">← App Conveyor</a></h1>
    <span class="subtitle">${pkg.commitHash.slice(0, 7)} &mdash; ${escHtml(pkg.message?.slice(0, 60) ?? "")}</span>
  </header>
  <div style="margin-bottom:1rem">
    <div style="color:var(--muted);font-size:0.75rem">
      ${escHtml(pkg.repoFullName)} / ${escHtml(pkg.branch)} &middot; ${escHtml(pkg.authorName ?? "")} &middot; ${relativeTime(pkg.createdAt)}
    </div>
  </div>
  ${rows}
</body>
</html>`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
