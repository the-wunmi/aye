/**
 * Plays a character through a built city's economy in seconds, to answer what a playtest takes
 * hours to: can someone reach their aim, how long does it take in real minutes, and how much of
 * their time goes on keeping themselves alive? It uses the city's own numbers and the rates the
 * realm plays at, with a sensible player's choices. It skips walking inside places, other
 * players and chance, so it judges balance and never whether anything is clear or fun.
 * A trusted dev tool: it reads only the worlds you pass, and changes nothing.
 *
 * Usage: node --env-file=../../.env scripts/play-through.ts <worldId> [realHours] [fillPermille]
 */
import { fileURLToPath } from "node:url";
import { FsArtifactStore } from "@aye/artifacts/node";
import { connect, systemGetPinnedPlace, systemGetWorld } from "@aye/db";
import { readJson } from "@aye/pipeline";
import {
  type ActionDef,
  type ArtifactHash,
  CitySpec,
  heldActionTicks,
  isOpen,
  moversOf,
  NEED_FILL_PERMILLE as PLAYED_FILL,
  placesOf,
  trip,
  tripPacePermille,
  WorldId,
  WorldSpec,
} from "@aye/schema";

const { db, close } = connect(process.env["DATABASE_URL"] as string, { max: 2 });
const store = new FsArtifactStore(
  fileURLToPath(new URL("../../../.aye/artifacts", import.meta.url)),
);
const ref = (h: string) => ({ hash: h as ArtifactHash, mediaType: "application/json", bytes: 0 });

/** Below this a sensible player stops what they're doing and sees to the need, permille. */
const SEE_TO_IT_BELOW = 250;
/** How long someone spends on arriving, choosing and walking to a thing, real seconds. */
const GETTING_THERE_S = 12;

const TICKS_PER_S = 30;
const NEED_FILL_PERMILLE = Number(process.argv[4] ?? PLAYED_FILL);
const settings = { ticksPerRealSecond: TICKS_PER_S };

interface Option {
  place: string;
  a: ActionDef;
}

try {
  const worldId = WorldId.parse(process.argv[2]);
  const limitS = Number(process.argv[3] ?? 6) * 3600;
  const world = await systemGetWorld(db, worldId);
  if (!world?.city) throw new Error("no such city");
  const city = CitySpec.parse(await readJson(store, ref(world.city)));
  const places = placesOf(city);
  const specs = new Map<string, WorldSpec>();
  for (const p of places) {
    const pin = await systemGetPinnedPlace(db, worldId, p.key);
    if (pin?.spec) specs.set(p.key, WorldSpec.parse(await readJson(store, ref(pin.spec))));
  }
  const pace = tripPacePermille(city, settings);
  const movers = moversOf(city);

  for (const start of city.starts) {
    if (!start.aim) {
      console.log(`\n${start.label}: has no aim to reach (written before aims existed)`);
      continue;
    }
    const options: Option[] = [];
    for (const p of places) {
      if (p.private && p.key !== start.home) continue;
      for (const k of specs.get(p.key)?.kinds ?? []) {
        for (const a of k.actions) {
          if (a.leaves && !a.income) continue;
          if ((a.marks ?? []).some((m) => m.by < 0)) continue;
          options.push({ place: p.key, a });
        }
      }
    }
    const needs = new Map(city.needs.map((n) => [n.key, 700]));
    const marks = new Map<string, number>();
    const aim = start.aim;
    let wallet = start.money;
    let owes = 0;
    let here = start.home;
    let realS = 0;
    let upkeepS = 0;
    let workS = 0;
    let practiceS = 0;
    let travelS = 0;
    let idleS = 0;
    let zeroS = 0;
    let earned = 0;
    let spent = 0;
    let billed = 0;
    let lastDay = 0;
    let doneAt: number | null = null;
    const minuteNow = () => 480 + Math.floor((realS * TICKS_PER_S) / 60);
    const goals = (aim?.steps ?? []).flatMap((s) => ("mark" in s ? [s] : []));
    const moneyGoal = (aim?.steps ?? []).flatMap((s) => ("money" in s ? [s.money] : []))[0] ?? 0;
    const wantMark = (key: string) =>
      goals.find((s) => s.mark === key && (marks.get(key) ?? 0) < s.atLeast);
    const goalMet = () =>
      wallet >= moneyGoal && goals.every((s) => (marks.get(s.mark) ?? 0) >= s.atLeast);
    const decay = (seconds: number) => {
      for (const n of city.needs) {
        const perS = (n.decayPerHour * TICKS_PER_S) / 3600;
        needs.set(n.key, Math.max(0, (needs.get(n.key) ?? 0) - perS * seconds));
      }
      if ([...needs.values()].some((v) => v <= 0)) zeroS += seconds;
      realS += seconds;
    };
    const payShare = () => {
      let share = 1000;
      for (const n of city.needs) {
        if (n.whenEmpty && (needs.get(n.key) ?? 0) <= 0) {
          share = Math.min(share, n.whenEmpty.payPermille);
        }
      }
      return share;
    };
    const allowed = ({ place, a }: Option) => {
      const p = places.find((x) => x.key === place);
      if (!p || !isOpen(p.hours, minuteNow() % 1440)) return false;
      if ((p.asks ?? []).some((x) => (marks.get(x.mark) ?? 0) < x.atLeast)) return false;
      if ((a.asks ?? []).some((x) => x.op === "gte" && (marks.get(x.mark) ?? 0) < x.value)) {
        return false;
      }
      if (a.requires.some((c) => "var" in c && c.op !== "eq")) return false;
      return wallet >= a.cost;
    };
    const go = (to: string) => {
      if (to === here) return 0;
      const from = places.find((p) => p.key === here);
      const dest = places.find((p) => p.key === to);
      if (!from || !dest) return 0;
      const legs = movers.map((m) => trip(m, from, dest, pace));
      const cheap = legs.filter((l) => l.fare <= wallet);
      const leg = cheap.sort((x, y) => x.minutes - y.minutes)[0] ?? legs[0];
      if (!leg) return 0;
      const seconds = (leg.minutes * 60) / TICKS_PER_S;
      wallet -= Math.min(wallet, leg.fare);
      spent += Math.min(wallet, leg.fare);
      here = to;
      return seconds;
    };
    while (realS < limitS && doneAt === null) {
      const day = Math.floor(minuteNow() / 1440);
      if (day > lastDay) {
        for (let d = lastDay + 1; d <= day; d++) {
          for (const b of city.economy.bills) {
            if (d % b.everyDays === 0) {
              const pay = Math.min(wallet, b.amount);
              wallet -= pay;
              owes += b.amount - pay;
              billed += b.amount;
            }
          }
        }
        lastDay = day;
      }
      const lowest = [...city.needs].sort(
        (x, y) => (needs.get(x.key) ?? 0) - (needs.get(y.key) ?? 0),
      )[0];
      const usable = options.filter(allowed);
      const seconds = (a: ActionDef) => heldActionTicks(a, settings) / TICKS_PER_S;
      const away = (o: Option) => (o.place === here ? 0 : 60);
      let choice: Option | undefined;
      let kind: "upkeep" | "work" | "practice" = "work";
      if (lowest && (needs.get(lowest.key) ?? 0) < SEE_TO_IT_BELOW) {
        const fills = (o: Option) =>
          o.a.needs.find((n) => n.need === lowest.key && n.perHour > 0)?.perHour ?? 0;
        const gain = (o: Option) =>
          (fills(o) * o.a.durationMin * NEED_FILL_PERMILLE) / 60_000 - o.a.cost / 100;
        choice = usable
          .filter((o) => fills(o) > 0)
          .sort(
            (x, y) =>
              gain(y) / (seconds(y.a) + away(y) + GETTING_THERE_S) -
              gain(x) / (seconds(x.a) + away(x) + GETTING_THERE_S),
          )[0];
        kind = "upkeep";
      }
      if (!choice) {
        choice = usable
          .filter((o) => (o.a.marks ?? []).some((m) => m.by > 0 && wantMark(m.mark)))
          .sort((x, y) => away(x) - away(y) || x.a.cost - y.a.cost)[0];
        kind = "practice";
      }
      if (!choice) {
        const rate = (o: Option) =>
          (o.a.income - o.a.cost) / (seconds(o.a) + away(o) + GETTING_THERE_S);
        choice = usable.filter((o) => o.a.income > 0).sort((x, y) => rate(y) - rate(x))[0];
        kind = "work";
      }
      if (!choice) {
        decay(30);
        idleS += 30;
        continue;
      }
      const ride = go(choice.place);
      travelS += ride;
      decay(ride + GETTING_THERE_S);
      const { a } = choice;
      const held = seconds(a);
      wallet -= a.cost;
      spent += a.cost;
      for (const e of a.needs) {
        const whole = (e.perHour * a.durationMin) / 60;
        const change = e.perHour > 0 ? (whole * NEED_FILL_PERMILLE) / 1000 : whole;
        needs.set(e.need, Math.min(1000, Math.max(0, (needs.get(e.need) ?? 0) + change)));
      }
      const pay = Math.floor((a.income * payShare()) / 1000);
      decay(held);
      const toDebt = Math.min(owes, pay);
      owes -= toDebt;
      wallet += pay - toDebt;
      earned += pay;
      for (const m of a.marks ?? []) {
        if (m.by <= 0) continue;
        // Level n to n+1 takes about n+1 goes: the sim's own rule, without the dice.
        const have = marks.get(m.mark) ?? 0;
        const chance = a.cost > 0 ? 1 : 1 / (have + 1);
        marks.set(m.mark, have + chance * m.by);
      }
      if (kind === "upkeep") upkeepS += held + GETTING_THERE_S;
      else if (kind === "practice") practiceS += held + GETTING_THERE_S;
      else workS += held + GETTING_THERE_S;
      if (goalMet()) doneAt = realS;
    }
    const min = (s: number) => Math.round(s / 60);
    const pct = (s: number) => `${Math.round((s * 100) / Math.max(1, realS))}%`;
    console.log(`\n${start.label} (starts with ${start.money / 100}, aim ${moneyGoal / 100})`);
    console.log(
      doneAt === null
        ? `  never reached it in ${min(limitS)} real minutes (ended with ${Math.floor(wallet / 100)})`
        : `  reached it in ${min(doneAt)} real minutes`,
    );
    console.log(
      `  time: upkeep ${pct(upkeepS)}, work ${pct(workS)}, practice ${pct(practiceS)}, travel ${pct(travelS)}, nothing to do ${pct(idleS)}; a need at zero ${pct(zeroS)}`,
    );
    console.log(
      `  money per real minute: earned ${Math.round(earned / 100 / Math.max(1, realS / 60))}, spent ${Math.round(spent / 100 / Math.max(1, realS / 60))}, billed ${Math.round(billed / 100 / Math.max(1, realS / 60))}`,
    );
  }
} finally {
  await close();
}
