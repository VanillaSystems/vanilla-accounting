/**
 * Where a typed message stands in the setup conversation before the books (#385). A message stays
 * with the step that waited when it was sent, between that step's question and its answer (the
 * answer came after it, by a click or from the words). A message whose step is gone (the words took
 * back the net tax rates, say) goes to the open step, so its question and buttons stay under her
 * newest message. In the order they were typed. Pure.
 */
export function placeTurns(steps: ReadonlyArray<{ key: string; open: boolean }>, turns: ReadonlyArray<{ at: string }>): Map<string, number[]> {
  const shown = new Set(steps.map((s) => s.key));
  const open = steps.find((s) => s.open)?.key;
  const out = new Map<string, number[]>();
  turns.forEach((turn, i) => {
    const key = shown.has(turn.at) ? turn.at : open ?? '';
    out.set(key, [...(out.get(key) ?? []), i]);
  });
  return out;
}
