// Builds the error-modal line list from stage state (Phase 1 task 8).
// Composition error strings come from openusd via StageInfo and already
// carry prim-path context — they are passed through verbatim, one per line.
export interface StageErrorInput {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  compositionErrors: string[];
}

export function stageModalErrorLines(input: StageErrorInput): string[] | null {
  if (input.status === "error" && input.error) {
    return ["Failed to open stage: " + input.error];
  }
  if (input.compositionErrors.length > 0) {
    return input.compositionErrors;
  }
  return null;
}
