/**
 * Core polling engine. Iterates all pipeline steps for each active Package.
 */
import type { PipelineConfig, Package, StepConfig, StepState } from "./types";
import { upsertPackage, upsertStepState, listPackages, getPackage } from "./db";
import { fetchLatestCommit, buildStepState } from "./modules/git";
import { syncGha } from "./modules/gha";
import { syncGhcr } from "./modules/ghcr";
import { syncFluxImage } from "./modules/flux-image";
import { syncFluxKustomize } from "./modules/flux-kustomize";
import { syncK8sDeploy } from "./modules/k8s-deploy";
import { now } from "./util";

export class Engine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private cfg: PipelineConfig) {}

  start() {
    if (this.running) return;
    this.running = true;
    const interval = this.cfg.pollIntervalMs ?? 60_000;
    // Run immediately, then on interval
    this.poll().catch(console.error);
    this.timer = setInterval(() => this.poll().catch(console.error), interval);
    console.log(`[engine] started, polling every ${interval / 1000}s`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.running = false;
  }

  async poll() {
    console.log(`[engine] poll at ${new Date().toISOString()}`);
    await this.discoverNewCommits();
    await this.advancePackages();
  }

  // ─── Step 1: discover new commits from Git step ──────────────────────────

  private async discoverNewCommits() {
    const gitSteps = this.cfg.steps.filter(s => s.type === "git");
    for (const step of gitSteps) {
      console.log(`[engine] git: checking ${step.repo}/${step.branch}`);
      try {
        const commit = await fetchLatestCommit(step);
        if (!commit) {
          console.log(`[engine] git: no commit returned for ${step.repo}/${step.branch}`);
          continue;
        }

        // Check if we already have this commit
        const existing = getPackage(commit.sha);
        if (existing) {
          console.log(`[engine] git: ${commit.sha.slice(0, 7)} already tracked`);
          continue;
        }

        console.log(`[engine] new commit ${commit.sha.slice(0, 7)} on ${step.repo}/${step.branch}: ${commit.message}`);

        // Create the package
        const pkg: Omit<Package, "steps"> = {
          id: commit.sha,
          commitHash: commit.sha,
          repoFullName: step.repo!,
          branch: step.branch!,
          authorName: commit.authorName,
          message: commit.message,
          createdAt: now(),
          updatedAt: now(),
          currentStep: 0,
        };
        upsertPackage(pkg);

        // Register the Git step as passed immediately
        const gitState = buildStepState(step, commit);
        upsertStepState(commit.sha, gitState);

        // Initialise remaining steps as pending
        for (const s of this.cfg.steps.filter(s2 => s2.type !== "git")) {
          upsertStepState(commit.sha, {
            stepId: s.id,
            status: "pending",
            label: "…",
            updatedAt: now(),
          });
        }
      } catch (e) {
        console.error(`[engine] git discover error:`, e);
      }
    }
  }

  // ─── Step 2: advance all packages through remaining steps ────────────────

  private async advancePackages() {
    const packages = listPackages(100);
    for (const pkg of packages) {
      // Skip fully-passed or failed packages older than 48h
      const allPassed = pkg.steps.every(s => s.status === "passed");
      if (allPassed) continue;

      await this.advancePackage(pkg);
    }
  }

  private async advancePackage(pkg: Package) {
    const stepMap = new Map(pkg.steps.map(s => [s.stepId, s]));
    // Build up upstream IDs as we go so each step sees the latest values
    const upstream = this.gatherUpstream(pkg.steps);

    for (const stepCfg of this.cfg.steps) {
      if (stepCfg.type === "git") continue; // already handled

      const current = stepMap.get(stepCfg.id);
      if (current?.status === "passed") continue; // done

      let newState: StepState;
      try {
        newState = await this.syncStep(stepCfg, upstream);
      } catch (e: any) {
        newState = {
          stepId: stepCfg.id,
          status: "failed",
          label: "err",
          detail: String(e?.message ?? e),
          updatedAt: now(),
        };
      }

      console.log(`[engine] ${pkg.commitHash.slice(0, 7)} [${stepCfg.id}] → ${newState.status} (${newState.label})${newState.detail ? ` | ${newState.detail}` : ""}`);
      upsertStepState(pkg.id, newState);

      // Propagate newly-acquired IDs forward so later steps can use them
      if (newState.commitHash) upstream.commitHash = newState.commitHash;
      if (newState.ghaRunId) upstream.ghaRunId = newState.ghaRunId;
      if (newState.imageDigest) upstream.imageDigest = newState.imageDigest;
      if (newState.imageTag) upstream.imageTag = newState.imageTag;
      if (newState.syncRevision) upstream.syncRevision = newState.syncRevision;

      // The pipeline is sequential: each step's output feeds the next.
      // Stop advancing if the step hasn't passed (or been skipped).
      // On the next poll we'll retry from this step.
      if (newState.status === "failed") {
        console.log(`[engine] ${pkg.commitHash.slice(0, 7)} stopped at [${stepCfg.id}]: failed`);
        break;
      }
      if (newState.status === "pending" || newState.status === "running") {
        break;
      }
    }

    // Update package's updatedAt
    upsertPackage({
      id: pkg.id,
      commitHash: pkg.commitHash,
      repoFullName: pkg.repoFullName,
      branch: pkg.branch,
      authorName: pkg.authorName,
      message: pkg.message,
      createdAt: pkg.createdAt,
      updatedAt: now(),
      currentStep: pkg.currentStep,
    });
  }

  private gatherUpstream(steps: StepState[]): {
    commitHash?: string;
    ghaRunId?: string;
    imageDigest?: string;
    imageTag?: string;
    syncRevision?: string;
  } {
    const result: ReturnType<typeof this.gatherUpstream> = {};
    for (const s of steps) {
      if (s.commitHash) result.commitHash = s.commitHash;
      if (s.ghaRunId) result.ghaRunId = s.ghaRunId;
      if (s.imageDigest) result.imageDigest = s.imageDigest;
      if (s.imageTag) result.imageTag = s.imageTag;
      if (s.syncRevision) result.syncRevision = s.syncRevision;
    }
    return result;
  }

  private async syncStep(
    cfg: StepConfig,
    upstream: ReturnType<typeof this.gatherUpstream>
  ): Promise<StepState> {
    const commitHash = upstream.commitHash ?? "";
    const imageDigest = upstream.imageDigest ?? "";
    const imageTag = upstream.imageTag ?? "";

    switch (cfg.type) {
      case "gha":
        return syncGha(cfg, commitHash);
      case "ghcr":
        return syncGhcr(cfg, commitHash);
      case "flux-image":
        return syncFluxImage(cfg, imageTag, imageDigest);
      case "flux-kustomize":
        return syncFluxKustomize(cfg, commitHash, imageTag);
      case "k8s-deploy":
        return syncK8sDeploy(cfg, imageDigest, imageTag);
      default:
        return {
          stepId: cfg.id,
          status: "skipped",
          label: "–",
          detail: `unknown step type: ${(cfg as any).type}`,
          updatedAt: now(),
        };
    }
  }
}
