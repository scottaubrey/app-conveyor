// ─── Pipeline Configuration ──────────────────────────────────────────────────

export type StepType =
  | "git"
  | "gha"
  | "ghcr"
  | "flux-image"
  | "flux-kustomize"
  | "k8s-deploy";

export interface StepConfig {
  id: string;
  type: StepType;
  // git
  repo?: string;
  branch?: string;
  // gha
  workflow?: string;
  // ghcr
  image?: string;
  // flux-image
  policy?: string;
  imageRepository?: string;
  // flux-kustomize
  name?: string;
  automation?: string; // ImageUpdateAutomation resource name
  // k8s-deploy
  namespace?: string;
  deployment?: string;
}

export interface PipelineConfig {
  pollIntervalMs?: number;
  steps: StepConfig[];
}

// ─── Package / Artifact ──────────────────────────────────────────────────────

export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface StepState {
  stepId: string;
  status: StepStatus;
  label: string;       // e.g. short commit hash, run ID, digest suffix
  detail?: string;     // longer tooltip / description
  updatedAt: string;   // ISO timestamp
  // IDs propagated downstream
  commitHash?: string;
  ghaRunId?: string;
  imageDigest?: string;
  imageTag?: string;
  syncRevision?: string;
}

export interface Package {
  id: string;           // commit_hash (primary key)
  commitHash: string;
  repoFullName: string;
  branch: string;
  authorName?: string;
  message?: string;
  createdAt: string;    // ISO
  updatedAt: string;    // ISO
  steps: StepState[];
  currentStep: number;  // index of last reached step
}
