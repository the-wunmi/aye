/**
 * World evals: does a place work as a life sim under its spec?
 *
 * Schema checks catch broken references and absurd numbers; they can't tell whether a world
 * hangs together. This reads the spec for things that can never happen, then plays it with its
 * own people and reports what went wrong, in words a model (or an owner) can act on. `error`s
 * mean the world is broken and goes back to the model; `warning`s are shown at review and also
 * offered to the model to improve on.
 *
 * Deterministic like the sim, so a verdict is a fact about a spec: usable as a test assertion
 * on live model output and as feedback in the authoring loop.
 */
import type { Condition, Scene, WorldSettings, WorldSpec } from "@aye/schema";
import { Sim, TICKS_PER_HOUR } from "./sim.ts";

/**
 * `error`: broken, it can't be used. `fix`: it works, but a player would hit this, so it goes back
 * to the model for as long as there are rounds left; if it stays, the place still opens.
 * `warning`: worth improving if the model's being asked again anyway.
 */
export interface WorldFinding {
  severity: "error" | "fix" | "warning";
  message: string;
}

export interface WorldEvaluation {
  findings: WorldFinding[];
  /** How many times each action was completed, by "Kind: Action" label. */
  actions: Record<string, number>;
  /** Hours each person spent with a satisfiable need at zero, and their money change. */
  people: { key: string; criticalHours: number; netMoney: number }[];
}

/** Hours a need may sit at zero per simulated day before a lived-in place counts as unlivable. */
const CRITICAL_HOURS_PER_DAY = 4;
/** More goes an hour than this, for one person, all day, and it's a chore rather than a life. */
const MOST_GOES_PER_HOUR = 2;
/** The best work anywhere pays about this many times an ordinary hour. */
const MOST_PAY_TIMES_ORDINARY = 3;

/** What an hour of pay should buy, permille of a need, at the least. */
const NEED_PER_HOUR_OF_PAY = 250;
/** The least time an action that raises a mark for almost nothing should take. */
const MARK_TAKES_MIN = 30;
/** What's done to fill a need should beat this many times what it loses by itself. */
const FILLS_TIMES_DECAY = 2;
/** Proper work this long or longer should cost at least this much of some need, per hour. */
const WORK_LEAST_MIN = 30;
const WORK_TIRES_PER_HOUR = 60;
/** What a night's sleep should fill of a need, in one go. */
const NIGHT_FILLS = 500;

function compare(v: number, c: Extract<Condition, { var: string }>): boolean {
  switch (c.op) {
    case "eq":
      return v === c.value;
    case "ne":
      return v !== c.value;
    case "gte":
      return v >= c.value;
    case "lte":
      return v <= c.value;
  }
}

/** An ordinary visitor to play-test a place nobody was written for. Never part of the world. */
function standIn(spec: WorldSpec): WorldSpec["people"][number] {
  return {
    key: "play_tester",
    name: "A visitor",
    about: "",
    colours: { skin: "#8d5a3b", top: "#808080", bottom: "#404040" },
    body: {
      widthMm: 450,
      stepMm: 200,
      stairs: true,
      slopePermille: 150,
      speedMmPerS: 1_300,
      seated: false,
    },
    money: Math.max(1_000_000, spec.hourPay * 40),
    needs: spec.needs.map((n) => ({ need: n.key, start: 700 })),
  };
}

/** Is there something here to lie on, free, that really puts right what a day takes out of you? */
function somewhereToSleep(spec: WorldSpec): boolean {
  const used = new Set(spec.things.map((t) => t.kind));
  return spec.kinds.some(
    (k) =>
      used.has(k.key) &&
      k.actions.some(
        (a) =>
          a.pose === "lie" &&
          a.cost === 0 &&
          !a.leaves &&
          a.needs.some((n) => Math.floor((n.perHour * a.durationMin) / 60) >= NIGHT_FILLS),
      ),
  );
}

/** Static reading of the spec: states, resources and needs that can never come about. */
export function staticFindings(spec: WorldSpec): WorldFinding[] {
  const out: WorldFinding[] = [];
  const supplied = new Set<string>();
  for (const r of spec.resources) {
    if (r.supply && r.supply.uptimePermille > 0) supplied.add(r.key);
  }
  for (const k of spec.kinds) {
    for (const s of k.supplies) {
      const needsItself = s.when.some((c) => "resource" in c && c.resource === s.resource);
      if (needsItself) {
        out.push({
          severity: "fix",
          message: `"${k.label}" supplies ${s.resource} only while ${s.resource} is on, so it can never start it. A supply can't need itself.`,
        });
      } else {
        supplied.add(s.resource);
      }
    }
  }
  const used = new Set(spec.things.map((t) => t.kind));
  for (const k of spec.kinds) {
    if (!used.has(k.key)) continue;
    // Values each var can take: its initial, what things start at, what actions set.
    const reachable = new Map<string, Set<number>>();
    for (const v of k.vars) reachable.set(v.key, new Set([v.initial]));
    for (const t of spec.things) {
      if (t.kind !== k.key) continue;
      for (const s of t.state) reachable.get(s.var)?.add(s.value);
    }
    for (const a of k.actions) for (const s of a.sets) reachable.get(s.var)?.add(s.value);
    const possible = (c: Condition) => {
      if ("resource" in c) return supplied.has(c.resource);
      return [...(reachable.get(c.var) ?? [])].some((v) => compare(v, c));
    };
    for (const a of k.actions) {
      for (const c of a.requires) {
        if (possible(c)) continue;
        out.push({
          severity: "error",
          message:
            "resource" in c
              ? `"${k.label}: ${a.label}" needs ${c.resource}, but nothing here supplies it.`
              : `"${k.label}: ${a.label}" waits for ${c.var} ${c.op} ${c.value}, which nothing ever sets.`,
        });
      }
    }
  }
  // A mark is earned: a quick free chore that raises one makes it worth nothing.
  const cheap: string[] = [];
  for (const k of spec.kinds) {
    if (!used.has(k.key)) continue;
    for (const a of k.actions) {
      const noRealPrice = a.cost * 2 < spec.hourPay || a.cost === 0;
      if (a.durationMin < MARK_TAKES_MIN && noRealPrice && (a.marks ?? []).some((m) => m.by > 0)) {
        cheap.push(`"${k.label}: ${a.label}"`);
      }
    }
  }
  if (cheap.length > 0) {
    out.push({
      severity: "fix",
      message: `These raise a mark for almost nothing, so it means nothing: ${cheap.slice(0, 8).join(", ")}. A mark should take real work or real money (at least ${MARK_TAKES_MIN} minutes, or a price). Quick chores shouldn't raise one.`,
    });
  }
  // What's bought should be worth what it costs: a meal that takes hours' pay fills you up.
  const poorValue: string[] = [];
  for (const k of spec.kinds) {
    if (!used.has(k.key) || spec.hourPay <= 0) continue;
    for (const a of k.actions) {
      if (a.cost < spec.hourPay || a.leaves || (a.marks ?? []).length > 0 || a.outcomes?.length) {
        continue;
      }
      const gives = a.needs.reduce(
        (sum, n) => sum + Math.max(0, Math.floor((n.perHour * a.durationMin) / 60)),
        0,
      );
      if (gives > 0 && gives * spec.hourPay < a.cost * NEED_PER_HOUR_OF_PAY) {
        poorValue.push(`"${k.label}: ${a.label}"`);
      }
    }
  }
  if (poorValue.length > 0) {
    out.push({
      severity: "fix",
      message: `These cost a lot and do little: ${poorValue.slice(0, 8).join(", ")}. Something bought for an hour's pay should fill at least ${NEED_PER_HOUR_OF_PAY / 10}% of what it's for; give more, or charge less.`,
    });
  }
  // A need's sign the wrong way round: a meal that makes you hungrier, paid for, gets you nothing.
  const onlyHurts: string[] = [];
  const paidToLose: string[] = [];
  const losesGround: string[] = [];
  const easyWork: string[] = [];
  for (const k of spec.kinds) {
    if (!used.has(k.key)) continue;
    for (const a of k.actions) {
      const fills = a.needs.filter((n) => n.perHour > 0);
      if (a.cost > 0 && (a.marks ?? []).some((m) => m.by < 0)) {
        paidToLose.push(`"${k.label}: ${a.label}"`);
      }
      const paysOff =
        a.income > 0 ||
        a.sets.length > 0 ||
        Boolean(a.leaves) ||
        Boolean(a.outcomes?.length) ||
        (a.marks ?? []).some((m) => m.by > 0);
      if (!paysOff && fills.length === 0 && a.needs.length > 0) {
        onlyHurts.push(`"${k.label}: ${a.label}"`);
      }
      // Done for what it gives, it has to give faster than the need runs down on its own.
      const decayOf = (need: string) => spec.needs.find((x) => x.key === need)?.decayPerHour ?? 0;
      if (
        !paysOff &&
        fills.length > 0 &&
        fills.every((n) => n.perHour <= decayOf(n.need) * FILLS_TIMES_DECAY)
      ) {
        losesGround.push(`"${k.label}: ${a.label}"`);
      }
      // Pay for free is what makes bills not matter: a day's work should take it out of you.
      const proper = a.income * 60 >= (spec.hourPay * a.durationMin) / 2;
      if (
        proper &&
        a.durationMin >= WORK_LEAST_MIN &&
        !a.leaves &&
        !a.needs.some((n) => n.perHour <= -WORK_TIRES_PER_HOUR)
      ) {
        easyWork.push(`"${k.label}: ${a.label}"`);
      }
    }
  }
  if (onlyHurts.length > 0) {
    out.push({
      severity: "fix",
      message: `Doing these only makes people worse off, so nobody would: ${onlyHurts.slice(0, 8).join(", ")}. In needs, a positive perHour fills the need and a negative one drains it: eating, drinking, washing and sleeping are positive.`,
    });
  }
  if (paidToLose.length > 0) {
    out.push({
      severity: "fix",
      message: `People pay for these and lose standing or skill for it: ${paidToLose.slice(0, 8).join(", ")}. In marks a negative by takes away what they've built up; something ordinary they buy shouldn't. Leave it out.`,
    });
  }
  if (losesGround.length > 0) {
    out.push({
      severity: "fix",
      message: `These are done for what they give, but the need runs down about as fast as they fill it, so nothing seems to happen: ${losesGround.slice(0, 8).join(", ")}. Give at least ${FILLS_TIMES_DECAY + 1} times what the need loses in an hour, usually several hundred.`,
    });
  }
  if (easyWork.length > 0) {
    out.push({
      severity: "fix",
      message: `These pay people but cost them nothing, so money stops mattering: ${easyWork.slice(0, 8).join(", ")}. Work takes it out of you: at least ${WORK_TIRES_PER_HOUR} an hour off a need (usually energy).`,
    });
  }
  // Used up for good: doing it spends what it needs, and nothing ever brings that back.
  const spent: string[] = [];
  for (const k of spec.kinds) {
    if (!used.has(k.key)) continue;
    for (const a of k.actions) {
      for (const s of a.sets) {
        const needs = a.requires.find(
          (c): c is Extract<Condition, { var: string }> => "var" in c && c.var === s.var,
        );
        if (!needs || s.forMin > 0 || compare(s.value, needs)) continue;
        const refilled = k.actions.some((b) =>
          b.sets.some((x) => x.var === s.var && compare(x.value, needs)),
        );
        if (!refilled) spent.push(`"${k.label}: ${a.label}"`);
      }
    }
  }
  if (spent.length > 0) {
    out.push({
      severity: "fix",
      message: `Once used, nothing ever brings these back, so they stop working for good: ${[...new Set(spent)].slice(0, 8).join(", ")}. Add something that refills them, or let them refill by themselves (forMin).`,
    });
  }
  // Going away for an action takes the person out of the place: going alone can't also be
  // done sitting or lying here, and most of what people do in a place keeps them in it.
  const away: string[] = [];
  for (const k of spec.kinds) {
    if (!used.has(k.key)) continue;
    for (const a of k.actions) {
      if (!a.leaves) continue;
      // Taking something out (a vehicle) is how people go places; going alone is rarer.
      if (!a.leaves.withThing) away.push(`"${k.label}: ${a.label}"`);
      // Sitting in what you leave with (driving off) is fine; sitting here while gone isn't.
      if (!a.leaves.withThing && (a.pose === "sit" || a.pose === "lie")) {
        out.push({
          severity: "error",
          message: `"${k.label}: ${a.label}" sends the person away from this place, yet they ${a.pose} here doing it: if they stay, it shouldn't leave.`,
        });
      }
    }
  }
  if (away.length > 3) {
    out.push({
      severity: "error",
      message: `${away.length} actions send people out of this place alone for their whole duration, so they vanish from here: ${away.slice(0, 8).join(", ")}. Only going somewhere else should leave; using things here stays.`,
    });
  }
  // Pay is what the whole game is balanced on: one job far above the rest makes the rest pointless.
  if (spec.hourPay > 0) {
    const overpaid: string[] = [];
    for (const k of spec.kinds) {
      if (!used.has(k.key)) continue;
      for (const a of k.actions) {
        if (a.income <= 0) continue;
        const perHour = Math.floor((a.income * 60) / Math.max(1, a.durationMin));
        if (perHour > spec.hourPay * MOST_PAY_TIMES_ORDINARY) {
          overpaid.push(`"${k.label}: ${a.label}" (${perHour} an hour)`);
        }
      }
    }
    if (overpaid.length > 0) {
      out.push({
        severity: "fix",
        message: `An hour of ordinary work pays ${spec.hourPay} here, but ${overpaid.slice(0, 8).join(", ")} pay${overpaid.length === 1 ? "s" : ""} more than ${MOST_PAY_TIMES_ORDINARY} times that. Pay less, or take longer; money only people's own work earns should never just appear.`,
      });
    }
  }
  if (spec.livedIn) {
    for (const n of spec.needs) {
      const met = spec.kinds.some(
        (k) =>
          used.has(k.key) &&
          k.actions.some((a) => a.needs.some((e) => e.need === n.key && e.perHour > 0)),
      );
      if (!met) {
        out.push({
          severity: "warning",
          message: `Nothing here satisfies ${n.label.toLowerCase()}.`,
        });
      }
    }
  }
  return out;
}

export function evaluateWorld(
  scene: Scene,
  spec: WorldSpec,
  settings: WorldSettings,
  /** `home`: someone wakes up here every day, whatever the world's author made of it. */
  opts: { hours?: number; home?: boolean } = {},
): WorldEvaluation {
  const findings = staticFindings(spec);
  if ((opts.home || spec.livedIn) && !somewhereToSleep(spec)) {
    findings.push({
      severity: "fix",
      message: `There's nowhere here to lie down for the night, so people here can never really recover. Give something to sleep on (a bed, a mat, a bench) a free action with pose "lie", lasting six to eight hours, staying here (leaves "no"), filling at least ${NIGHT_FILLS} of what tired people are short of in one go.`,
    });
  }
  const hours = opts.hours ?? (spec.livedIn ? 48 : 6);
  // A place with nobody written for it (a real one someone filmed) is played by a stand-in.
  const players = spec.people.length > 0 ? spec.people : [standIn(spec)];
  const sim = new Sim({ scene, spec, settings, people: players });
  if (sim.things.length < spec.things.length) {
    findings.push({
      severity: "warning",
      message: `${spec.things.length - sim.things.length} thing(s) aren't on the main floor and won't be used.`,
    });
  }
  // Things nobody here can get to (walled in, behind something solid): the world can fix what
  // it marked solid; a blocked layout needs a different place.
  {
    const probe = new Sim({ scene, spec, settings, people: players });
    probe.step([]);
    const kindOf = new Map(spec.things.map((t) => [t.object as string, t.kind]));
    const labelOf = new Map(spec.kinds.map((k) => [k.key, k.label]));
    const unreachable = probe.things
      .filter((t, ti) => {
        if (!spec.kinds.find((k) => k.key === kindOf.get(t.id))?.actions.length) return false;
        for (let i = 0; i < probe.agentIds.length; i++) {
          if (probe.present[i] && probe.canReach(i, ti)) return false;
        }
        return true;
      })
      .map((t) => labelOf.get(kindOf.get(t.id) ?? "") ?? t.id);
    if (unreachable.length > 0) {
      findings.push({
        severity: "fix",
        message: `Nobody can get to ${unreachable.length} thing(s) with things to do: ${[...new Set(unreachable)].slice(0, 8).join(", ")}. If something solid is in the way that people could pass under or over (a ceiling fan, a TV on a wall, a rug), it shouldn't be solid.`,
      });
    }
  }

  const n = sim.agentIds.length;
  const here = sim.agentIds.flatMap((_, i) => (sim.present[i] ? [i] : []));
  const N = sim.needKeys.length;
  const satisfiable = new Set<number>();
  sim.needKeys.forEach((key, k) => {
    const met = spec.kinds.some((kind) =>
      kind.actions.some((a) => a.needs.some((e) => e.need === key && e.perHour > 0)),
    );
    if (met) satisfiable.add(k);
  });
  const zeroTicks = new Int32Array(n * N);
  const startMoney = Float64Array.from(sim.wallet);
  const actions: Record<string, number> = {};
  const labelOf = new Map(
    spec.kinds.flatMap((k) =>
      k.actions.map((a) => [`${k.key}/${a.key}`, `${k.label}: ${a.label}`] as const),
    ),
  );
  const kindOfThing = new Map(spec.things.map((t) => [t.object as string, t.kind]));
  const tried = new Set<string>();
  const total = Math.round(hours * TICKS_PER_HOUR);
  for (let tick = 0; tick < total; tick++) {
    for (const e of sim.step()) {
      if (e.type === "action_started") tried.add(`${kindOfThing.get(e.object)}/${e.action}`);
      if (e.type !== "action_finished") continue;
      const label = labelOf.get(`${kindOfThing.get(e.object)}/${e.action}`) ?? e.action;
      actions[label] = (actions[label] ?? 0) + 1;
    }
    for (let i = 0; i < n; i++) {
      for (const k of satisfiable) {
        const at = i * N + k;
        if ((sim.needs[at] as number) === 0) zeroTicks[at] = (zeroTicks[at] as number) + 1;
      }
    }
  }

  const days = Math.max(1, hours / 24);
  const people = here.map((i) => {
    const key = sim.agentIds[i] as string;
    const name = sim.people[i]?.name ?? key;
    let criticalHours = 0;
    sim.needKeys.forEach((need, k) => {
      const h = Math.floor((zeroTicks[i * N + k] as number) / TICKS_PER_HOUR);
      criticalHours += h;
      if (spec.livedIn && h > CRITICAL_HOURS_PER_DAY * days) {
        const label = spec.needs[k]?.label.toLowerCase() ?? need;
        findings.push({
          severity: "warning",
          message: `${name}'s ${label} sat at zero for ${h} h over ${hours} h.`,
        });
      }
    });
    const netMoney = Math.round((sim.wallet[i] as number) - (startMoney[i] as number));
    return { key, criticalHours, netMoney };
  });
  // The point of a multi-step thing (uncover, open, then drive off) is the last step: in a
  // place people live, if nobody ever got that far, it isn't worth the steps before it.
  if (spec.livedIn && hours >= 24) {
    const placed = new Set(sim.things.map((t) => kindOfThing.get(t.id)));
    const unreached: string[] = [];
    for (const kind of spec.kinds) {
      if (!placed.has(kind.key)) continue;
      for (const a of kind.actions) {
        const gated = a.requires.some(
          (c) =>
            "var" in c && kind.actions.some((b) => b !== a && b.sets.some((x) => x.var === c.var)),
        );
        if ((gated || a.leaves?.withThing) && !tried.has(`${kind.key}/${a.key}`)) {
          // Going out with something is the point of the steps before it: said first.
          const line = `${kind.label}: ${a.label}`;
          if (a.leaves?.withThing) unreached.unshift(line);
          else unreached.push(line);
        }
      }
    }
    if (unreached.length > 0) {
      findings.push({
        severity: "warning",
        message: `In ${hours} h nobody got as far as ${unreached.slice(0, 6).join("; ")}. People choose whatever does most for their lowest needs per hour, so these lose to everything else here: raise what they (and the steps before them) do for needs, until they beat the ordinary things people do instead.`,
      });
    }
  }
  // Someone doing the same thing every few minutes, all day: one go isn't doing enough.
  const chores = Object.entries(actions)
    .filter(([, times]) => here.length > 0 && times / (hours * here.length) > MOST_GOES_PER_HOUR)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 4);
  if (chores.length > 0) {
    findings.push({
      severity: "fix",
      message: `In ${hours} h one person did ${chores.map(([label, times]) => `${label} ${times} times`).join(", ")}. Nobody lives like that: one go should see to the need for hours, so it should do more for the need, or take longer, or the need should fall more slowly.`,
    });
  }
  if (Object.keys(actions).length === 0 && here.length > 0) {
    findings.push({
      severity: "error",
      message: `Nobody did anything in ${hours} simulated hours.`,
    });
  }
  return { findings, actions, people };
}
