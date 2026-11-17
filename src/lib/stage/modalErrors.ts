// Builds the stage-modal content from stage state (Phase 1 task 8).
// Composition messages come from openusd via StageInfo: notices state a
// limit the open survived, errors are real composition failures. Both are
// passed through verbatim, one per line.
export interface StageErrorInput {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  compositionErrors: string[];
  compositionNotices?: string[];
}

export interface StageModalContent {
  notices: string[];
  errors: string[];
}

export function stageModalContent(input: StageErrorInput): StageModalContent | null {
  if (input.status === "error" && input.error) {
    return { notices: [], errors: ["Failed to open stage: " + input.error] };
  }
  const notices = input.compositionNotices ?? [];
  if (notices.length === 0 && input.compositionErrors.length === 0) {
    return null;
  }
  return { notices, errors: input.compositionErrors };
}
