// Branch appearance application (Task 8): one commit per subtree gprim
// through the shared stageState wrappers. The backend rejects edits on
// instance prims, so the caller feeds only collectSubtreeGprims paths and
// reports skippedInstances itself.

export interface BranchResult {
  applied: number;
  failed: number;
  errors: string[];
}

// shortcut: per-prim undo granularity, no group undo; upgrade to a batched
// backend command if multi-prim undo ever matters
export async function applyToBranch(
  commit: (path: string) => Promise<string | null>,
  paths: string[],
): Promise<BranchResult> {
  const result: BranchResult = { applied: 0, failed: 0, errors: [] };
  for (const path of paths) {
    // The edits are actor-serialized in the backend anyway; awaiting keeps
    // the order stable and one prim's failure from aborting the rest.
    const error = await commit(path);
    if (error === null) result.applied += 1;
    else {
      result.failed += 1;
      result.errors.push(`${path}: ${error}`);
    }
  }
  return result;
}

// The user-facing summary of a branch application: what applied, what
// failed, and which instanced prims were skipped up front.
export function branchSummary(result: BranchResult, skippedInstances: string[]): string {
  const parts = [`applied to ${result.applied} prim${result.applied === 1 ? "" : "s"}`];
  if (result.failed > 0) parts.push(`${result.failed} failed: ${result.errors.join("; ")}`);
  if (skippedInstances.length > 0) {
    parts.push(`skipped ${skippedInstances.length} instance prim${skippedInstances.length === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}
