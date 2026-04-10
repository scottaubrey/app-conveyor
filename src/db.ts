import { Database } from "bun:sqlite";
import { runMigrations } from "./migrations";
import type {
  Package,
  PipelineConfig,
  StepHistoryEntry,
  StepState,
} from "./types";
import { now } from "./util";

interface PackageRow {
  id: string;
  pipeline_id: string;
  commit_hash: string;
  repo: string;
  branch: string;
  author_name: string | null;
  message: string | null;
  created_at: string;
  updated_at: string;
  current_step: number;
  config_snapshot: string | null;
  status: string;
}

interface StepStateRow {
  id: number;
  package_id: string;
  step_id: string;
  status: string;
  label: string;
  detail: string | null;
  updated_at: string;
  commit_hash: string | null;
  gha_run_id: string | null;
  image_digest: string | null;
  image_tag: string | null;
  sync_revision: string | null;
}

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  _db = new Database(process.env.DB_PATH ?? "conveyor.db", { create: true });
  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA foreign_keys = ON");
  runMigrations(_db);
  return _db;
}

// ─── Package CRUD ─────────────────────────────────────────────────────────────

export function upsertPackage(pkg: Omit<Package, "steps">): void {
  const db = getDb();
  db.run(
    `
    INSERT INTO packages (id, pipeline_id, commit_hash, repo, branch, author_name, message, created_at, updated_at, current_step, config_snapshot, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      updated_at      = excluded.updated_at,
      current_step    = excluded.current_step,
      author_name     = excluded.author_name,
      message         = excluded.message,
      status          = excluded.status
  `,
    [
      pkg.id,
      pkg.pipelineId,
      pkg.commitHash,
      pkg.repoFullName,
      pkg.branch,
      pkg.authorName ?? null,
      pkg.message ?? null,
      pkg.createdAt,
      pkg.updatedAt,
      pkg.currentStep,
      pkg.configSnapshot ? JSON.stringify(pkg.configSnapshot) : null,
      pkg.status,
    ],
  );
}

export function upsertStepState(packageId: string, state: StepState): void {
  const db = getDb();
  const prev = db
    .query<{ status: string; label: string }, [string, string]>(
      "SELECT status, label FROM step_states WHERE package_id = ? AND step_id = ?",
    )
    .get(packageId, state.stepId);

  db.run(
    `
    INSERT INTO step_states
      (package_id, step_id, status, label, detail, updated_at,
       commit_hash, gha_run_id, image_digest, image_tag, sync_revision)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(package_id, step_id) DO UPDATE SET
      status        = excluded.status,
      label         = excluded.label,
      detail        = excluded.detail,
      updated_at    = excluded.updated_at,
      commit_hash   = excluded.commit_hash,
      gha_run_id    = excluded.gha_run_id,
      image_digest  = excluded.image_digest,
      image_tag     = excluded.image_tag,
      sync_revision = excluded.sync_revision
  `,
    [
      packageId,
      state.stepId,
      state.status,
      state.label,
      state.detail ?? null,
      state.updatedAt,
      state.commitHash ?? null,
      state.ghaRunId ?? null,
      state.imageDigest ?? null,
      state.imageTag ?? null,
      state.syncRevision ?? null,
    ],
  );

  if (!prev || prev.status !== state.status) {
    db.run(
      `
      INSERT INTO step_history (package_id, step_id, status, label, detail, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      [
        packageId,
        state.stepId,
        state.status,
        state.label,
        state.detail ?? null,
        state.updatedAt,
      ],
    );
  }
}

export function getPackage(id: string): Package | null {
  const db = getDb();
  const row = db
    .query<PackageRow, [string]>("SELECT * FROM packages WHERE id = ?")
    .get(id);
  if (!row) return null;
  return hydrate(db, row);
}

export function findPackageByCommitPrefix(
  pipelineId: string,
  prefix: string,
): Package | null {
  const db = getDb();
  const rows = db
    .query<PackageRow, [string]>(
      "SELECT * FROM packages WHERE pipeline_id = ? ORDER BY created_at DESC LIMIT 200",
    )
    .all(pipelineId);
  const row = rows.find((r) => r.commit_hash.startsWith(prefix));
  return row ? hydrate(db, row) : null;
}

export function listPackages(pipelineId: string, limit = 50): Package[] {
  const db = getDb();
  const rows = db
    .query<PackageRow, [string, number]>(
      "SELECT * FROM packages WHERE pipeline_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(pipelineId, limit);
  return rows.map((r) => hydrate(db, r));
}

export function listActivePackages(pipelineId: string, limit = 100): Package[] {
  const db = getDb();
  const rows = db
    .query<PackageRow, [string, number]>(
      "SELECT * FROM packages WHERE pipeline_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT ?",
    )
    .all(pipelineId, limit);
  return rows.map((r) => hydrate(db, r));
}

function hydrate(db: Database, row: PackageRow): Package {
  const steps = db
    .query<StepStateRow, [string]>(
      "SELECT * FROM step_states WHERE package_id = ? ORDER BY id ASC",
    )
    .all(row.id)
    .map(rowToStep);

  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    commitHash: row.commit_hash,
    repoFullName: row.repo,
    branch: row.branch,
    authorName: row.author_name ?? undefined,
    message: row.message ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    currentStep: row.current_step,
    configSnapshot: row.config_snapshot
      ? JSON.parse(row.config_snapshot)
      : undefined,
    status: row.status as Package["status"],
    steps,
  };
}

function rowToStep(r: StepStateRow): StepState {
  return {
    stepId: r.step_id,
    status: r.status as StepState["status"],
    label: r.label,
    detail: r.detail ?? undefined,
    updatedAt: r.updated_at,
    commitHash: r.commit_hash ?? undefined,
    ghaRunId: r.gha_run_id ?? undefined,
    imageDigest: r.image_digest ?? undefined,
    imageTag: r.image_tag ?? undefined,
    syncRevision: r.sync_revision ?? undefined,
  };
}

export function getStepHistory(
  packageId: string,
  stepId: string,
): StepHistoryEntry[] {
  const db = getDb();
  return db
    .query<StepHistoryEntry, [string, string]>(
      "SELECT * FROM step_history WHERE package_id = ? AND step_id = ? ORDER BY id DESC LIMIT 20",
    )
    .all(packageId, stepId);
}

// ─── Package supersede ────────────────────────────────────────────────────────

/**
 * Marks active packages as superseded if a newer fully-passed package exists.
 *
 * A "fully passed" package is complete with no failed steps. Once such a
 * package exists, any older active packages will never deploy — the system has
 * moved past them. Their in-progress steps are marked skipped and the package
 * is removed from the active polling set.
 *
 * Returns the number of packages superseded.
 */
export function supersedeBefore(pipelineId: string): number {
  const db = getDb();

  // Newest complete package where no step failed (i.e. all passed/skipped)
  const anchor = db
    .query<{ created_at: string }, [string]>(
      `SELECT p.created_at
       FROM packages p
       WHERE p.pipeline_id = ?
         AND p.status = 'complete'
         AND NOT EXISTS (
           SELECT 1 FROM step_states s
           WHERE s.package_id = p.id AND s.status = 'failed'
         )
       ORDER BY p.created_at DESC
       LIMIT 1`,
    )
    .get(pipelineId);

  if (!anchor) return 0;

  const stale = db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM packages
       WHERE pipeline_id = ? AND status = 'active' AND created_at < ?`,
    )
    .all(pipelineId, anchor.created_at);

  const ts = now();
  const detail = "superseded by newer deployment";

  for (const { id } of stale) {
    const inProgress = db
      .query<{ step_id: string }, [string]>(
        `SELECT step_id FROM step_states
         WHERE package_id = ? AND status IN ('pending', 'running')`,
      )
      .all(id);

    for (const { step_id } of inProgress) {
      db.run(
        "UPDATE step_states SET status = 'skipped', label = '–', detail = ?, updated_at = ? WHERE package_id = ? AND step_id = ?",
        [detail, ts, id, step_id],
      );
      db.run(
        "INSERT INTO step_history (package_id, step_id, status, label, detail, recorded_at) VALUES (?, ?, 'skipped', '–', ?, ?)",
        [id, step_id, detail, ts],
      );
    }
    db.run(
      "UPDATE packages SET status = 'superseded', updated_at = ? WHERE id = ?",
      [ts, id],
    );
  }

  // Repair invariant: already-superseded packages must not have pending/running
  // steps. This handles any race conditions that slipped through (e.g. the
  // migration ran while the package was still active).
  const orphaned = db
    .query<{ package_id: string; step_id: string }, [string]>(
      `SELECT ss.package_id, ss.step_id
       FROM step_states ss
       JOIN packages p ON p.id = ss.package_id
       WHERE p.pipeline_id = ? AND p.status = 'superseded'
         AND ss.status IN ('pending', 'running')`,
    )
    .all(pipelineId);

  for (const { package_id, step_id } of orphaned) {
    db.run(
      "UPDATE step_states SET status = 'skipped', label = '–', detail = ?, updated_at = ? WHERE package_id = ? AND step_id = ?",
      [detail, ts, package_id, step_id],
    );
    db.run(
      "INSERT INTO step_history (package_id, step_id, status, label, detail, recorded_at) VALUES (?, ?, 'skipped', '–', ?, ?)",
      [package_id, step_id, detail, ts],
    );
  }

  return stale.length;
}

// ─── Package reset ─────────────────────────────────────────────────────────────

/**
 * Resets a package so the engine will re-advance it from scratch:
 * - Git steps (preserveStepIds) are left untouched.
 * - Steps absent from newSnapshot (if provided) are marked 'skipped'.
 * - All remaining steps are reset to 'pending'.
 * - If newSnapshot is provided, config_snapshot is updated.
 *
 * Status changes are recorded in step_history for auditability.
 */
export function resetPackage(
  packageId: string,
  preserveStepIds: string[],
  newSnapshot?: PipelineConfig,
): void {
  const db = getDb();
  const ts = now();
  const preserveSet = new Set(preserveStepIds);
  const newStepIds = newSnapshot
    ? new Set(newSnapshot.steps.map((s) => s.id))
    : null;

  const rows = db
    .query<{ step_id: string; status: string }, [string]>(
      "SELECT step_id, status FROM step_states WHERE package_id = ?",
    )
    .all(packageId);

  for (const { step_id, status } of rows) {
    if (preserveSet.has(step_id)) continue;

    const isOrphaned = newStepIds !== null && !newStepIds.has(step_id);
    const newStatus = isOrphaned ? "skipped" : "pending";
    const newLabel = isOrphaned ? "–" : "…";
    const newDetail = isOrphaned ? "step removed from pipeline config" : null;

    db.run(
      "UPDATE step_states SET status = ?, label = ?, detail = ?, updated_at = ? WHERE package_id = ? AND step_id = ?",
      [newStatus, newLabel, newDetail, ts, packageId, step_id],
    );

    if (status !== newStatus) {
      db.run(
        "INSERT INTO step_history (package_id, step_id, status, label, detail, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
        [packageId, step_id, newStatus, newLabel, newDetail, ts],
      );
    }
  }

  if (newSnapshot) {
    db.run(
      "UPDATE packages SET config_snapshot = ?, status = 'active', updated_at = ? WHERE id = ?",
      [JSON.stringify(newSnapshot), ts, packageId],
    );
  } else {
    db.run(
      "UPDATE packages SET status = 'active', updated_at = ? WHERE id = ?",
      [ts, packageId],
    );
  }
}
