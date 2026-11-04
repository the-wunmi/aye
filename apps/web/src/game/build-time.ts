/**
 * How long a new city usually takes, for whoever's waiting. The range comes from how long real
 * builds took, so it improves as more are made; until there are enough, it's the range we've
 * seen. What's being said about the build itself is the city's own: a model writes those lines.
 */

export interface BuildRange {
  lowMin: number;
  highMin: number;
}

const USUAL: BuildRange = { lowMin: 10, highMin: 15 };

export const usualWait = (typical: BuildRange | null | undefined) => {
  const { lowMin, highMin } = typical ?? USUAL;
  return lowMin === highMin ? `about ${lowMin} minutes` : `${lowMin} to ${highMin} minutes`;
};

export function waitNote(
  madeAtMs: number,
  nowMs: number,
  typical: BuildRange | null | undefined,
): string {
  const spentMin = Math.max(0, Math.floor((nowMs - madeAtMs) / 60_000));
  if (spentMin >= (typical ?? USUAL).highMin) return "Taking longer than usual. It's still going.";
  const spent = spentMin === 1 ? "1 minute" : `${spentMin} minutes`;
  return `Usually ${usualWait(typical)}. ${spent} so far.`;
}
