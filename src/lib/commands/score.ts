// Fuzzy ranking for the palette: a case-insensitive subsequence match, with
// name matches ranked above description matches. Pure, no reactive state.

import type { Command } from "./registry.mjs";

// Weights keep the ordering the palette needs without a formula anyone has to
// reverse-engineer: an earlier and tighter match dominates any length, and a
// length difference always beats nothing. An exact match starts at 0 with no
// gaps, so it tops the list on the base formula alone.
const START_WEIGHT = 1000;
const GAP_WEIGHT = 100;

/** Descending score, or null when `query` is not a subsequence of `text`. Both lowercase. */
function matchScore(text: string, query: string): number | null {
  const haystack = text.toLowerCase();
  let from = 0;
  let start = -1;
  let gaps = 0;
  for (const ch of query) {
    const at = haystack.indexOf(ch, from);
    if (at < 0) return null;
    if (start < 0) start = at;
    else gaps += at - from;
    from = at + 1;
  }
  return -start * START_WEIGHT - gaps * GAP_WEIGHT - haystack.length;
}

function ranked(matches: { cmd: Command; score: number }[]): Command[] {
  // Sort is stable, so equal scores keep registry order.
  return matches.sort((a, b) => b.score - a.score).map((match) => match.cmd);
}

export function rankCommands(
  cmds: Command[],
  query: string,
): { nameMatches: Command[]; descriptionMatches: Command[] } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { nameMatches: [...cmds], descriptionMatches: [] };

  const nameMatches: { cmd: Command; score: number }[] = [];
  const descriptionMatches: { cmd: Command; score: number }[] = [];
  for (const cmd of cmds) {
    const nameScore = matchScore(cmd.name, needle);
    if (nameScore !== null) {
      nameMatches.push({ cmd, score: nameScore });
      continue;
    }
    const descriptionScore = matchScore(cmd.description, needle);
    if (descriptionScore !== null) descriptionMatches.push({ cmd, score: descriptionScore });
  }
  return { nameMatches: ranked(nameMatches), descriptionMatches: ranked(descriptionMatches) };
}
