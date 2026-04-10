/**
 * Flux Automation — checks if Flux ImagePolicy has picked up the new tag.
 */
import { getKubeClient } from "../kube";
import type { StepConfig, StepState } from "../types";
import { errorMessage, isK8sNotFound, now } from "../util";

interface FluxImagePolicy {
  status?: {
    latestRef?: { tag?: string };
    conditions?: Array<{ type: string; status: string; message?: string }>;
  };
}

interface FluxAutomation {
  status?: {
    lastPushTime?: string;
    lastPushCommit?: string;
  };
}

export async function syncFluxImage(
  cfg: StepConfig,
  imageTag: string,
  imageDigest: string,
): Promise<StepState> {
  const base: Omit<StepState, "status" | "label" | "detail"> = {
    stepId: cfg.id,
    updatedAt: now(),
    imageTag,
    imageDigest,
  };

  if (!cfg.policy) {
    return {
      ...base,
      status: "skipped",
      label: "–",
      detail: "policy not configured",
    };
  }

  const namespace = cfg.namespace ?? "flux-system";

  try {
    const client = getKubeClient();
    const customObjects = client.customObjects;

    const policy = (await customObjects.getNamespacedCustomObject({
      group: "image.toolkit.fluxcd.io",
      version: "v1beta2",
      namespace,
      plural: "imagepolicies",
      name: cfg.policy,
    })) as FluxImagePolicy;

    // v1beta2 ImagePolicy: status.latestRef.tag holds the selected tag
    const latestTag: string = policy?.status?.latestRef?.tag ?? "";
    const ready = policy?.status?.conditions?.find((c) => c.type === "Ready");

    if (!latestTag) {
      return {
        ...base,
        status: "pending",
        label: "waiting",
        detail: "no latestRef yet",
      };
    }
    if (!imageTag) {
      return {
        ...base,
        status: "pending",
        label: "waiting",
        detail: "waiting for image tag from registry step",
      };
    }

    // Check if the policy has selected our tag (or a tag containing our hash).
    // imageTag may be a full 40-char SHA while latestTag embeds only the short
    // 7-char prefix (e.g. "g0d0db12" in a trunkver tag), so also check the
    // short prefix.
    const shortHash = imageTag.slice(0, 7);
    const tagMatches =
      latestTag === imageTag ||
      latestTag.includes(imageTag) ||
      latestTag.includes(shortHash);

    if (!tagMatches) {
      return {
        ...base,
        status: "running",
        label: latestTag,
        detail: `latestRef.tag: ${latestTag} | ${ready?.message ?? ""}`,
      };
    }

    // Policy has our tag. If an ImageUpdateAutomation is configured, wait for
    // it to commit the tag change to the GitOps repo — that commit is the real
    // output of this step (and what flux-kustomize needs to verify).
    if (cfg.automation) {
      try {
        const automation = (await customObjects.getNamespacedCustomObject({
          group: "image.toolkit.fluxcd.io",
          version: "v1beta2",
          namespace,
          plural: "imageupdateautomations",
          name: cfg.automation,
        })) as FluxAutomation;

        const pushCommit = automation?.status?.lastPushCommit;
        const rawPushTime = automation?.status?.lastPushTime;

        if (!pushCommit || !rawPushTime) {
          return {
            ...base,
            status: "running",
            label: latestTag,
            detail: `latestRef.tag: ${latestTag} | waiting for ${cfg.automation} to push`,
          };
        }

        return {
          ...base,
          status: "passed",
          label: pushCommit.slice(0, 7),
          syncRevision: pushCommit,
          detail: `latestRef.tag: ${latestTag} | ${ready?.message ?? ""} | push: ${pushCommit.slice(0, 7)}`,
        };
      } catch (e: unknown) {
        if (isK8sNotFound(e)) {
          return {
            ...base,
            status: "pending",
            label: "waiting",
            detail: `ImageUpdateAutomation ${cfg.automation} not found`,
          };
        }
        throw e;
      }
    }

    return {
      ...base,
      status: "passed",
      label: latestTag,
      detail: `latestRef.tag: ${latestTag} | ${ready?.message ?? ""}`,
    };
  } catch (e: unknown) {
    if (isK8sNotFound(e)) {
      return {
        ...base,
        status: "pending",
        label: "waiting",
        detail: `ImagePolicy ${cfg.policy} not found`,
      };
    }
    return { ...base, status: "failed", label: "err", detail: errorMessage(e) };
  }
}
