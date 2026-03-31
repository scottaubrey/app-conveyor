import type { PipelineConfig } from "./types";

// Load from CONFIG_PATH env var, or fall back to a bundled example.
export async function loadConfig(): Promise<PipelineConfig> {
  const configPath = process.env.CONFIG_PATH;
  if (configPath) {
    const file = Bun.file(configPath);
    if (await file.exists()) {
      const text = await file.text();
      return JSON.parse(text) as PipelineConfig;
    }
    throw new Error(`CONFIG_PATH set but file not found: ${configPath}`);
  }

  // Built-in example — replace with your real config
  return {
    pollIntervalMs: 60_000,
    steps: [
      {
        id: "src",
        type: "git",
        repo: process.env.GIT_REPO ?? "my-org/web-app",
        branch: process.env.GIT_BRANCH ?? "main",
      },
      {
        id: "ci",
        type: "gha",
        repo: process.env.GIT_REPO ?? "my-org/web-app",
        workflow: process.env.GHA_WORKFLOW ?? "deploy.yaml",
      },
      {
        id: "reg",
        type: "ghcr",
        image: process.env.GHCR_IMAGE ?? "ghcr.io/my-org/web-app",
      },
      {
        id: "auto",
        type: "flux-image",
        policy: process.env.FLUX_IMAGE_POLICY ?? "web-app-policy",
        imageRepository: process.env.FLUX_IMAGE_REPO ?? "web-app",
        namespace: process.env.FLUX_NAMESPACE ?? "flux-system",
      },
      {
        id: "sync",
        type: "flux-kustomize",
        name: process.env.FLUX_KUSTOMIZE ?? "web-app-prod",
        automation: process.env.FLUX_AUTOMATION,
        namespace: process.env.FLUX_NAMESPACE ?? "flux-system",
      },
      {
        id: "live",
        type: "k8s-deploy",
        name: process.env.K8S_DEPLOYMENT ?? "web-app-deployment",
        namespace: process.env.K8S_NAMESPACE ?? "prod",
      },
    ],
  };
}
