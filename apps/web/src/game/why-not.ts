/**
 * Why someone can't do something right now, in words, or null if they can. The action menu shows
 * it, and whatever starts an action from elsewhere (a job board, a quest) says it instead of
 * sending a command that would only come back as "not now". The server still decides.
 */
import type { ActionDef, Condition, RosterEntry, Snapshot } from "@aye/schema";
import type { PlaceState } from "./useGame.ts";

function holds(
  conditions: readonly Condition[],
  vars: ReadonlyMap<string, number>,
  base: number,
  snap: Snapshot,
  resources: readonly string[],
): boolean {
  return conditions.every((c) => {
    if ("resource" in c) return snap.resourcesOn[resources.indexOf(c.resource)] === 1;
    const v = vars.get(c.var);
    if (v === undefined) return false;
    return holdsValue(snap.thingVars[base + v] ?? 0, c.op, c.value);
  });
}

function holdsValue(value: number, op: "eq" | "ne" | "gte" | "lte", against: number): boolean {
  return op === "eq"
    ? value === against
    : op === "ne"
      ? value !== against
      : op === "gte"
        ? value >= against
        : value <= against;
}

export function whyNot(args: {
  place: PlaceState;
  /** The thing's object id. */
  thing: string | null;
  action: ActionDef;
  snap: Snapshot;
  slot: number;
  acting: string;
  roster: readonly RosterEntry[];
  wallet: number;
}): string | null {
  const { place, thing, action: a, snap, slot, acting, roster, wallet } = args;
  const def = place.spec.things.find((t) => t.object === thing);
  const kind = place.spec.kinds.find((k) => k.key === def?.kind);
  const layout = place.things.find((t) => t.id === thing);
  if (!layout) return "\u2026";
  const vars = new Map(kind?.vars.map((v, i) => [v.key, i]) ?? []);
  const resources = place.spec.resources.map((r) => r.key);
  if (snap.thingAway[place.things.indexOf(layout)]) return "Not here right now";
  if (snap.shut && !a.leaves && (a.cost > 0 || a.income > 0)) return "Closed now";
  if (!holds(a.requires, vars, layout.base, snap, resources)) {
    // Doing it again would change nothing, or something else has to come first: say which.
    const stateOf = (key: string) => snap.thingVars[layout.base + (vars.get(key) ?? 0)] ?? 0;
    // Something you do for what it gives you isn't "done": it's waiting on what it uses up.
    const justASwitch = a.needs.length === 0 && a.income === 0;
    if (justASwitch && a.sets.length > 0 && a.sets.every((s) => stateOf(s.var) === s.value)) {
      return "Already done";
    }
    const missing = a.requires.find((c) => !holds([c], vars, layout.base, snap, resources));
    if (missing && "resource" in missing) {
      const r = place.spec.resources.find((x) => x.key === missing.resource);
      return r ? `No ${r.label.toLowerCase()} right now` : "Not possible yet";
    }
    const first = kind?.actions.find(
      (b) =>
        b !== a &&
        missing &&
        b.sets.some(
          (s) =>
            "var" in missing &&
            s.var === missing.var &&
            holdsValue(s.value, missing.op, missing.value),
        ),
    );
    if (first) return `First: ${first.label}`;
    const waiting =
      missing && "var" in missing ? kind?.vars.find((v) => v.key === missing.var)?.label : null;
    return waiting ? `Waiting on: ${waiting}` : "Not possible yet";
  }
  if (wallet < a.cost) return "Can't afford";
  // What it asks of you, in the city's own words: Cooking 3, Tariq 2.
  const markList = place.spec.marks ?? [];
  for (const ask of a.asks ?? []) {
    const j = markList.findIndex((m) => m.key === ask.mark);
    const have = j < 0 ? 0 : (snap.marks[slot * markList.length + j] ?? 0);
    if (ask.op === "gte" ? have < ask.value : have > ask.value) {
      const label = markList[j]?.label ?? ask.mark;
      return ask.op === "gte" ? `Needs ${label} ${ask.value}` : `You've done this`;
    }
  }
  // It's someone's: they can take it out, and nobody else without paying a fare.
  if (a.leaves?.withThing && a.cost === 0 && def?.owner && def.owner !== acting) {
    const whose = roster.find((r) => r.key === def.owner)?.person.name;
    return whose ? `${whose}'s` : "Not yours";
  }
  return null;
}
