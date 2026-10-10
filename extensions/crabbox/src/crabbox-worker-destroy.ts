import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import type { LeaseCommandContext } from "./crabbox-worker-command.js";
import {
  assertCrabboxLeaseId,
  parseCrabboxProfile,
  resolveCrabboxWarmImageProfile,
} from "./crabbox-worker-profile.js";
import type { createCrabboxWarmImageManager } from "./crabbox-worker-warm-image.js";

/** Settles optional capture before releasing the exact source lease. */
export function createCrabboxWorkerDestroy(deps: {
  stopHeartbeat: (leaseId: string) => Promise<void>;
  resolveLeaseContext: (lease: Parameters<WorkerProvider["destroy"]>[0]) => Promise<{
    context: LeaseCommandContext;
    profile: ReturnType<typeof parseCrabboxProfile>;
  }>;
  warmImages: Pick<ReturnType<typeof createCrabboxWarmImageManager>, "lookupLease" | "capture">;
  stopLease: (context: LeaseCommandContext) => Promise<void>;
  warn: (message: string) => void;
}): WorkerProvider["destroy"] {
  return async (lease, options) => {
    assertCrabboxLeaseId(lease.leaseId);
    const reportPhase = (phase: "capturing" | "stopping") => {
      try {
        options?.onPhase?.(phase);
      } catch {
        // Advisory progress cannot prevent capture settlement or lease cleanup.
      }
    };
    // Stop renewal before binary acquisition can delay or fail teardown.
    await deps.stopHeartbeat(lease.leaseId);
    const { context, profile } = await deps.resolveLeaseContext(lease);
    // Enrollment records placement sizing omitted by lifecycle profiles.
    let captureError: unknown;
    try {
      const allocation = await deps.warmImages.lookupLease(context.id);
      const captureProfile = resolveCrabboxWarmImageProfile(
        profile,
        allocation?.machineClass ?? profile.class,
        allocation ? (allocation.os ?? "linux") : profile.target,
      );
      if (captureProfile.warmImage) {
        reportPhase("capturing");
        await deps.warmImages.capture({ ...context, profile: captureProfile });
      }
    } catch (error) {
      captureError = error;
    }
    reportPhase("stopping");
    await deps.stopLease(context);
    if (captureError) {
      // Capture recovery remains recorded separately from confirmed source cleanup.
      deps.warn(
        `Crabbox warm image capture failed during teardown: ${coerceErrorMessage(captureError)}`,
      );
    }
  };
}
