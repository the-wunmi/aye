/**
 * Playing a city. Two views of one live world: the map (where everything is, how to get
 * there) and the place you're in. Around them, the HUD and panels exactly as the city's model
 * designed them. Your character is always somewhere real (a place, or on the way); the map
 * is just a way of looking.
 */
import {
  type Character,
  closenessKey,
  emptyCost,
  heldActionTicks,
  type Intent,
  moversOf,
  nextBill,
  placesOf,
  tripPacePermille,
} from "@aye/schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../api.ts";
import { cityClock, clockText, money, moneyOwed } from "../format.ts";
import { AskPlace, type Mark } from "../game/AskPlace.tsx";
import { FilmPlace } from "../game/FilmPlace.tsx";
import { Hud, type HudContext, type NeedView } from "../game/Hud.tsx";
import { MakeYours } from "../game/MakeYours.tsx";
import { MapView } from "../game/MapView.tsx";
import { Panel } from "../game/Panel.tsx";
import { PlaceSheet } from "../game/PlaceSheet.tsx";
import { type CameraControls, PlaceView, Stick } from "../game/PlaceView.tsx";
import { PlanCard } from "../game/PlanCard.tsx";
import { bestForNeed, type GoTarget, visiblePlaces } from "../game/sources.ts";
import type { CityBundle } from "../game/types.ts";
import { useCityLife } from "../game/useCityLife.ts";
import { useGame } from "../game/useGame.ts";
import { useLand, useNetwork } from "../game/useNetwork.ts";
import { usePlan } from "../game/usePlan.ts";
import { whyNot } from "../game/why-not.ts";
import { pathOf } from "../route.ts";
import { SaveAccount } from "./SaveAccount.tsx";

type AskStatus =
  | { status: "working" }
  | {
      status: "done";
      result: { ok: true; thing: string; added: string[] } | { ok: false; reason: string };
    };

/** How many times to look for a moved thing, half a second apart. */
const MOVE_POLLS = 60;
/** How many times to look for an answer, 3 s apart: well past the worst any ask has taken. */
const ASK_POLLS = 400;

const tourKey = (worldId: string) => `aye:tour:${worldId}`;
const seenTour = (worldId: string) => {
  try {
    return localStorage.getItem(tourKey(worldId)) === "1";
  } catch {
    return false;
  }
};

/** Filming, building and asking need an account; the offer sits where those would be. */
function GuestNudge({ onSaved }: { onSaved(handle: string): void }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <div className="w w-card film-card">
      <SaveAccount
        why="Add a name and password to film places, ask the world and make your home yours. You keep everything."
        onSaved={onSaved}
      />
      <button type="button" className="link" onClick={() => setOpen(false)}>
        Not now
      </button>
    </div>
  ) : (
    <button type="button" className="sys-pill" onClick={() => setOpen(true)}>
      Save your account
    </button>
  );
}

export function Game({
  worldId,
  bundle: initial,
  character,
  handle,
  guest,
  onSaved,
  startFilming,
  openPlace,
  onLeave,
  onSignedOut,
}: {
  worldId: string;
  bundle: CityBundle;
  character: Character;
  handle: string;
  /** Playing without an account: what spends model credit asks for one first. */
  guest?: boolean;
  onSaved?(handle: string): void;
  /** They came here to film something: open that straight away. */
  startFilming?: boolean;
  /** A link named somewhere: show it, and they go there the usual way if they want to. */
  openPlace?: string | null;
  onLeave(): void;
  /** The session ended (logged out in another tab): nothing here can work any more. */
  onSignedOut(): void;
}) {
  // The city keeps being built and dressed while people play: refresh what we know of it.
  const [bundle, setBundle] = useState(initial);
  useEffect(() => {
    const t = setInterval(() => {
      api<CityBundle>(`/worlds/${worldId}/city`)
        .then(setBundle)
        .catch(() => undefined);
    }, 30_000);
    return () => clearInterval(t);
  }, [worldId]);
  const { city } = bundle;
  const game = useGame(worldId, city.currency, handle);
  const { state, send } = game;
  /** The place a link named, if it's somewhere they could see and they aren't already there. */
  const linked = (() => {
    const home = initial.city.starts.find((s) => s.key === character.start)?.home ?? null;
    const at = placesOf(initial.city).find((p) => p.key === openPlace);
    if (!at || (at.private && at.key !== home)) return null;
    return at.key === (character.place ?? home) ? null : at.key;
  })();
  const [view, setView] = useState<"map" | "place">(linked ? "map" : "place");
  const [sheet, setSheet] = useState<string | null>(linked);
  const [panel, setPanel] = useState<{ key: string; app: string | null } | null>(null);
  const panels = city.ui.panels;
  // Someone whose money has moved has lived here already, whatever this browser remembers.
  const returning =
    character.person.money !== city.starts.find((s) => s.key === character.start)?.money;
  const [tour, setTour] = useState<number | null>(
    // Someone who came to film gets on with that; the welcome waits for their next visit.
    seenTour(worldId) || returning || startFilming ? null : 0,
  );
  const [backend, setBackend] = useState("");
  const [follow, setFollow] = useState(true);
  const [lifeOn, setLifeOn] = useState(true);
  const network = useNetwork(city);
  const land = useLand(city);
  const plan = usePlan(worldId, city, network);
  const [planning, setPlanning] = useState(false);
  const [road, setRoad] = useState<number | null>(null);
  const planView = useMemo(
    () =>
      planning
        ? {
            closed: plan.edits.closed,
            edited: plan.edits.lanes.map(([l]) => l),
            selected: road,
            change: plan.result,
          }
        : null,
    [planning, plan.edits, plan.result, road],
  );
  const life = useCityLife(
    city,
    bundle.createdAt,
    bundle.settings,
    lifeOn && view === "map",
    network,
  );
  const camera = useRef<CameraControls | null>(null);
  const [, tickClock] = useState(0);

  // The city clock runs even when no snapshot arrives (on the map, on the way).
  useEffect(() => {
    const t = setInterval(() => tickClock((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Arriving somewhere shows it.
  const placeKey = state.place?.key ?? null;
  // The address says what you're looking at, so it can be shared and a reload lands there.
  const shownPlace = sheet ?? (view === "place" ? placeKey : null);
  useEffect(() => {
    if (placeKey || shownPlace) history.replaceState(null, "", pathOf(worldId, shownPlace));
  }, [placeKey, shownPlace, worldId]);
  /** Coming in by a link, the first arrival is only where they already were: the link stays up. */
  const arrivedByLink = useRef(linked !== null);
  useEffect(() => {
    if (placeKey) {
      if (arrivedByLink.current) {
        arrivedByLink.current = false;
        return;
      }
      setView("place");
      setSheet(null);
    }
  }, [placeKey]);
  useEffect(() => {
    if (state.transit) setView("map");
  }, [state.transit]);

  const home = city.starts.find((s) => s.key === character.start)?.home ?? null;
  const here = placeKey ?? state.transit?.to ?? character.place;
  const clock = state.snap?.clock ?? cityClock(bundle.createdAt, bundle.settings);
  const built = useMemo(() => new Set(Object.keys(bundle.catalog)), [bundle.catalog]);

  // Who you're acting as: the person you hold, else yourself.
  const you = state.place?.you ?? null;
  const held = state.roster.find((r) => r.heldBy === handle && !r.player);
  const acting = held?.key ?? you;
  const actingEntry = state.roster.find((r) => r.key === acting);
  const slot = actingEntry?.slot;
  const spec = state.place?.spec;
  const yourSlot = state.roster.find((r) => r.key === you)?.slot;
  // The last word from the server about you (money and needs move on in places); between
  // places that is what's true, not what the character was when the page loaded.
  const last = useRef({
    wallet: character.person.money,
    needs: new Map(character.person.needs.map((n) => [n.need, n.start])),
  });
  if (spec && state.snap && yourSlot !== undefined) {
    const w = state.snap.wallet[yourSlot];
    if (w !== undefined) last.current.wallet = w;
    spec.needs.forEach((n, k) => {
      const v = state.snap?.needs[yourSlot * spec.needs.length + k];
      if (v !== undefined) last.current.needs.set(n.key, v);
    });
  }
  const needs: NeedView[] =
    spec && state.snap && slot !== undefined
      ? spec.needs.map((n, k) => ({
          key: n.key,
          label: n.label,
          level: state.snap?.needs[slot * spec.needs.length + k] ?? 0,
        }))
      : city.needs.map((n) => ({
          key: n.key,
          label: n.label,
          level: last.current.needs.get(n.key) ?? 0,
        }));
  const wallet =
    state.snap && yourSlot !== undefined
      ? (state.snap.wallet[yourSlot] ?? null)
      : state.place
        ? null
        : last.current.wallet;
  const signedOut = state.closedCode === 4001;
  useEffect(() => {
    if (signedOut) onSignedOut();
  }, [signedOut, onSignedOut]);
  const doing =
    state.snap && slot !== undefined
      ? state.snap.doing[slot] || (state.snap.modes[slot] === 1 ? city.words.walking : "")
      : "";

  /** Take away a filmed place, once they've said they mean it. It can't be undone. */
  const removePlace = async (key: string) => {
    const name = placesOf(city).find((p) => p.key === key)?.name ?? "this place";
    const sure = window.confirm(
      `Delete ${name} and its video for everyone? Anyone in it goes home. This can't be undone.`,
    );
    if (!sure) return;
    const say = (text: string) => setTold({ id: Date.now(), text });
    try {
      const { job } = await api<{ job: string }>(
        `/worlds/${worldId}/places/${encodeURIComponent(key)}`,
        {},
        "DELETE",
      );
      for (let i = 0; i < MOVE_POLLS * 4; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const s = await api<
          | { status: "working" }
          | { status: "done"; result: { ok: true } | { ok: false; reason: string } }
        >(`/removals/${job}`);
        if (s.status !== "done") continue;
        if (!s.result.ok) {
          say(s.result.reason);
          return;
        }
        setSheet(null);
        say(`${name} and its video are gone.`);
        setBundle(await api<CityBundle>(`/worlds/${worldId}/city`));
        return;
      }
      say("That's taking too long. It may still finish.");
    } catch {
      say("That didn't work. Try again.");
    }
  };

  /** Moves made and not saved: leaving loses them, so it asks first. */
  const unsavedMoves = useRef(false);
  const setUnsavedMoves = useCallback((any: boolean) => {
    unsavedMoves.current = any;
  }, []);
  const okToLeave = () =>
    !unsavedMoves.current || window.confirm("Leave without saving what you've moved?");

  const intent = useCallback(
    (it: Intent) => {
      switch (it.do) {
        case "map":
          if (!okToLeave()) return;
          setView("map");
          return;
        case "panel":
          setPanel({ key: it.panel, app: null });
          return;
        case "open_app": {
          // On whichever panel carries it.
          const on = panels.find((p) => p.apps.includes(it.app));
          if (on) setPanel({ key: on.key, app: it.app });
          return;
        }
        case "show_place":
          setPanel(null);
          // Where you already are: stay in it (don't walk out to look at it on the map).
          if (it.place === placeKey) {
            setView("place");
            return;
          }
          setView("map");
          setSheet(it.place);
          return;
        case "tour":
          setTour(0);
          return;
      }
    },
    [panels, placeKey],
  );

  const [asking, setAsking] = useState<string | null>(null);
  const [told, setTold] = useState<{ id: number; text: string } | null>(null);
  // What an answer about this place is pointing at.
  const [marks, setMarks] = useState<readonly Mark[]>([]);
  // Filming a real place in: where it goes, if the player chooses.
  const [filmSpot, setFilmSpot] = useState<[number, number] | null>(null);
  const [pickingSpot, setPickingSpot] = useState(false);
  // You spoke: someone here may be answering (they take a little while). Until a line from
  // someone else arrives, or it's clear nobody will.
  const [waiting, setWaiting] = useState<number | null>(null);
  const lastLine = state.chat.at(-1);
  useEffect(() => {
    if (waiting === null) return;
    if (lastLine && lastLine.agent !== you && lastLine.shownAt > 0) {
      setWaiting(null);
      return;
    }
    const t = setTimeout(() => setWaiting(null), 45_000);
    return () => clearTimeout(t);
  }, [waiting, lastLine, you]);
  useEffect(() => {
    if (!told) return;
    const t = setTimeout(() => setTold((c) => (c?.id === told.id ? null : c)), 7_000);
    return () => clearTimeout(t);
  }, [told]);

  // What you're doing right now, and how far along: work takes a while, and you should see it.
  const myDoing =
    state.snap &&
    yourSlot !== undefined &&
    // Acting here, or gone off doing it (out of sight, so this is all there is to see).
    (state.snap.modes[yourSlot] === 2 || state.snap.modes[yourSlot] === 3)
      ? (state.snap.doing[yourSlot] ?? "")
      : "";
  const started = useRef<{ label: string; at: number } | null>(null);
  if (!myDoing) started.current = null;
  else if (started.current?.label !== myDoing) {
    started.current = { label: myDoing, at: performance.now() };
  }
  const working = (() => {
    if (!myDoing || !started.current || !spec) return null;
    const action = spec.kinds.flatMap((k) => k.actions).find((a) => a.label === myDoing);
    if (!action) return null;
    const totalMs =
      (heldActionTicks(action, bundle.settings) / bundle.settings.ticksPerRealSecond) * 1000;
    const elapsed = performance.now() - started.current.at;
    const done = Math.min(1, elapsed / Math.max(1, totalMs));
    const leftSec = Math.ceil((totalMs - elapsed) / 1000);
    // Left to themselves, people take as long as it really takes: don't sit on a false "0s".
    return { label: myDoing, done, left: leftSec > 0 ? `${leftSec}s left` : "" };
  })();

  // Money that has to be found: what you're behind on, or what's falling due soon.
  const billText = (() => {
    if (state.owes > 0) return `\u{1F4B8} You owe ${moneyOwed(state.owes, city.currency)}`;
    const next = nextBill(city.economy.bills, clock.day - 1);
    if (!next) return null;
    return `\u{1F4B8} ${next.bill.name} ${money(next.bill.amount, city.currency)} \u{00B7} Day ${next.day + 1}`;
  })();

  // Everything you carry, by key, as last seen: the map has no sim of its own to ask.
  const lastMarks = useRef<Readonly<Record<string, number>> | undefined>(undefined);
  if (state.snap && slot !== undefined && spec?.marks?.length) {
    const count = spec.marks.length;
    lastMarks.current = Object.fromEntries(
      spec.marks.map((m, j) => [m.key, state.snap?.marks[slot * count + j] ?? 0]),
    );
  }
  // A skill or standing moving is news: rises are the reward, falls shouldn't go unnoticed.
  const seenMarks = useRef<Readonly<Record<string, number>> | undefined>(undefined);
  useEffect(() => {
    const now = lastMarks.current;
    const before = seenMarks.current;
    seenMarks.current = now;
    if (!now || !before) return;
    const moved = (spec?.marks ?? []).flatMap((m) => {
      const by = (now[m.key] ?? 0) - (before[m.key] ?? 0);
      return m.shown && by !== 0 ? [`${m.label} ${by > 0 ? "+" : ""}${by}`] : [];
    });
    if (moved.length > 0) setTold({ id: Date.now(), text: moved.join(" \u{00B7} ") });
  }, [state.snap, spec]);

  const markOf = (key: string) => lastMarks.current?.[key] ?? 0;
  const closenessOf = (person: string) => markOf(closenessKey(person));

  // What stays with you that's worth showing, once you have some.
  const shownMarks = (() => {
    const list = spec?.marks ?? [];
    if (!state.snap || slot === undefined) return [];
    return list.flatMap((m, j) => {
      const value = state.snap?.marks[slot * list.length + j] ?? 0;
      return m.shown && value > 0 ? [{ label: m.label, value }] : [];
    });
  })();

  // A need that's run out and costs something: you should know why work pays less.
  const feeling = (() => {
    if (!state.snap || !spec || slot === undefined) return null;
    const count = spec.needs.length;
    const now = emptyCost(spec.needs, (_, j) => state.snap?.needs[slot * count + j] ?? 1);
    if (!now.feeling) return null;
    const costs = [
      now.payPermille < 1000 ? `work pays ${Math.round(now.payPermille / 10)}%` : "",
      now.walkPermille < 1000 ? `walking ${Math.round(now.walkPermille / 10)}% speed` : "",
    ].filter(Boolean);
    return [now.feeling, ...costs].join(" \u{00B7} ");
  })();

  /** What helps a need most, of what you can get to and pay for; here, unless that barely helps. */
  const bestFor = (need: string) =>
    bestForNeed(
      need,
      {
        bundle,
        here,
        home,
        minute: (clock.day - 1) * 1440 + clock.minuteOfDay,
        roster: state.roster,
        online: state.online,
        ...(lastMarks.current ? { marks: lastMarks.current } : {}),
      },
      wallet,
    );

  // A need running out shouldn't leave anyone wondering where to go: say the best answer.
  const seenEmpty = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (needs.length === 0) return;
    const empty = new Set(needs.filter((n) => n.level <= 0).map((n) => n.key));
    const before = seenEmpty.current;
    seenEmpty.current = empty;
    if (!before) return;
    const fresh = needs.find((n) => empty.has(n.key) && !before.has(n.key));
    if (!fresh) return;
    const best = bestFor(fresh.key);
    setTold({
      id: Date.now(),
      text: best
        ? `${fresh.label} ran out. Try ${best.title}: ${best.detail}`
        : `${fresh.label} ran out.`,
    });
  });

  // Something to do somewhere: go there (the player picks how), then do it on arrival.
  const [pending, setPending] = useState<GoTarget | null>(null);
  const doHere = useCallback(
    (t: GoTarget) => {
      const things = (state.place?.spec.things ?? []).filter((x) => x.kind === t.kind);
      // Of several, not one that belongs to somebody else if there's another.
      const preferred = things.find((x) => !x.owner || x.owner === acting) ?? things[0];
      if (!preferred || !t.action) {
        setTold({ id: Date.now(), text: `${t.label}: not here any more` });
        return;
      }
      const place = state.place;
      const snap = state.snap;
      const action = place?.spec.kinds
        .find((k) => k.key === t.kind)
        ?.actions.find((a) => a.key === t.action);
      let thing = preferred;
      if (place && snap && action && slot !== undefined && acting) {
        const reason = (object: string) =>
          whyNot({
            place,
            thing: object,
            action,
            snap,
            slot,
            acting,
            roster: state.roster,
            wallet: snap.wallet[slot] ?? 0,
          });
        const can = [preferred, ...things].find((x) => reason(x.object) === null);
        // Saying what's in the way beats sending something that can only come back "not now".
        if (!can) {
          setTold({ id: Date.now(), text: `${t.label}: ${reason(preferred.object)}` });
          return;
        }
        thing = can;
      }
      // What happens next shows in the world (walking over, then doing it), or as the
      // server's reason it can't: no message of our own on top.
      send({ t: "do", cmd: { type: "use", object: thing.object, action: t.action } });
    },
    [state.place, state.snap, state.roster, slot, send, acting],
  );
  const go = useCallback(
    (t: GoTarget) => {
      setPanel(null);
      if (placeKey === t.place) {
        setView("place");
        setSheet(null);
        if (t.kind) doHere(t);
        return;
      }
      setPending(t.kind ? t : null);
      setView("map");
      setSheet(t.place);
    },
    [placeKey, doHere],
  );
  const snapReady = state.snap !== null;
  useEffect(() => {
    if (pending && placeKey === pending.place && snapReady) {
      setPending(null);
      doHere(pending);
    }
  }, [pending, placeKey, snapReady, doHere]);
  /** Save a rearrangement: the server decides, and the place comes back changed. */
  const moveThings = async (
    moves: { object: string; xMm: number; zMm: number; yawDeg: number }[],
  ): Promise<boolean> => {
    if (!state.place) return false;
    const say = (text: string) => setTold({ id: Date.now(), text });
    try {
      const { job, home: isHome } = await api<{ job: string; home: boolean }>(
        `/worlds/${worldId}/places/${state.place.key}/move`,
        { moves },
      );
      for (let i = 0; i < MOVE_POLLS; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const s = await api<
          | { status: "working" }
          | { status: "done"; result: { ok: true } | { ok: false; reason: string } }
        >(isHome ? `/homes/${job}` : `/moves/${job}`);
        if (s.status !== "done") continue;
        if (!s.result.ok) {
          say(s.result.reason);
          return false;
        }
        // Your own home is your own copy, and it's the room you're in that takes it.
        if (isHome) send({ t: "buy_home", job });
        return true;
      }
      say("That's taking too long. Try again.");
    } catch (err) {
      say(
        err instanceof ApiError && err.code === "rate_limited"
          ? "You've moved a lot of things just now. Give it a minute."
          : "That didn't save. Try again.",
      );
    }
    return false;
  };

  /** Ask the world to let a thing do something new; the place updates for everyone. */
  const ask = async (object: string, request: string) => {
    if (!state.place) return;
    const say = (text: string) => setTold({ id: Date.now(), text });
    try {
      setAsking(request);
      const { job } = await api<{ job: string }>(
        `/worlds/${worldId}/places/${state.place.key}/ask`,
        { object, request },
      );
      // However long it takes and wherever they've gone by then, the answer still reaches them.
      for (let i = 0; i < ASK_POLLS; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const s = await api<AskStatus>(`/asks/${job}`);
        if (s.status === "done") {
          say(
            s.result.ok
              ? `${s.result.thing}: you can now ${s.result.added.join(", ").toLowerCase()}`
              : `Couldn't: ${s.result.reason}.`,
          );
          return;
        }
      }
      say("Couldn't work that out in the end.");
    } catch (err) {
      say(
        err instanceof ApiError && err.code === "rate_limited"
          ? "You've asked a lot this hour."
          : "Couldn't ask that.",
      );
    } finally {
      setAsking(null);
    }
  };
  const transit = state.transit;
  const progress = transit
    ? Math.min(1, (performance.now() - transit.startedAt) / Math.max(1, transit.etaMs))
    : 0;
  const mode = transit ? moversOf(city).find((m) => m.key === transit.mode) : null;
  const dest = transit ? placesOf(city).find((p) => p.key === transit.to) : null;
  const lifeSlot =
    city.population.groups.length > 0 ? (
      <div className="life-card">
        <button
          type="button"
          className="sys-pill"
          aria-pressed={lifeOn}
          onClick={() => setLifeOn((o) => !o)}
        >
          {lifeOn ? "Hide city life" : "Show city life"}
        </button>
        {lifeOn && !planning && life.stats && (
          <div className="w w-card life-stats" aria-live="polite">
            <div className="w-title">{city.name} now</div>
            <div className="bar-row">
              <span>People</span>
              <strong>{life.people.toLocaleString()}</strong>
            </div>
            <div className="bar-row">
              <span>Out and about</span>
              <strong>{life.stats.travelling.toLocaleString()}</strong>
            </div>
            <div className="bar-row">
              <span>On the roads</span>
              <strong>{life.stats.onRoads.toLocaleString()}</strong>
            </div>
            <div className="bar-row">
              <span>Traffic speed</span>
              <strong>{Math.round(life.stats.flowPermille / 10)}%</strong>
            </div>
            <div className="bar-row">
              <span>Busiest road</span>
              <strong>
                {network && life.stats.worstEdge >= 0
                  ? `${network.names[network.links[life.stats.worstEdge * 7 + 6] ?? -1] ?? "Unnamed road"}, `
                  : ""}
                {life.stats.worstPermille >= 1000
                  ? "full"
                  : `${Math.round(life.stats.worstPermille / 10)}% full`}
              </strong>
            </div>
            <details className="muted small">
              <summary>How this is worked out</summary>
              {life.scale > 1 ? `Each traveller you see stands for ${life.scale} people. ` : ""}
              {city.real
                ? "Real roads (lanes, speed limits, one-ways); who lives here and their days are a model's estimate, not calibrated against counts."
                : "A plausible day for an invented city, not a forecast."}
            </details>
          </div>
        )}
      </div>
    ) : null;
  const planSlot = network ? (
    planning ? (
      <PlanCard
        plan={plan}
        network={network}
        selected={road}
        onClose={() => {
          setPlanning(false);
          setRoad(null);
        }}
      />
    ) : (
      <button
        type="button"
        className="sys-pill"
        onClick={() => {
          setPlanning(true);
          setLifeOn(false);
        }}
      >
        {"\u{1F6E0}\u{FE0F}"} Plan roads
      </button>
    )
  ) : null;
  const tripSlot =
    transit && dest ? (
      <div className="transit" role="status">
        <span className="transit-icon" aria-hidden>
          {mode?.icon}
        </span>
        <div className="grow">
          <div>
            {mode?.label ?? city.words.onTheWay} {"\u{2192}"} <strong>{dest.name}</strong>
          </div>
          <div className="bar">
            <div className="bar-fill t-good" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      </div>
    ) : view === "place" && acting && state.out[acting] ? (
      <div className="transit" role="status">
        <div className="grow">
          <div>
            <strong>{actingEntry?.person.name ?? character.person.name}</strong>:{" "}
            {[state.out[acting]?.action, state.out[acting]?.thing]
              .filter(Boolean)
              .join(" \u{00B7} ")}
          </div>
          <div className="muted small">
            {"\u{21A9}\u{FE0F}"} {clockText((state.out[acting]?.backAtMinute ?? 0) % 1440)}
          </div>
        </div>
      </div>
    ) : null;
  const placeName = placesOf(city).find((p) => p.key === here)?.name ?? null;
  const hud: HudContext = {
    city,
    screen: view,
    wallet,
    clock,
    actingName: actingEntry?.person.name ?? character.person.name,
    needs,
    doing,
    marks: shownMarks,
    priceOf: (place: string, kind: string, action: string) =>
      bundle.catalog[place]?.actions.find((a) => a.kind === kind && a.action === action)?.cost ?? 0,
    seeTo: (need: string) => {
      const busy = state.snap && slot !== undefined ? state.snap.doing[slot] : "";
      if (busy) {
        setTold({ id: Date.now(), text: `Finish or stop ${busy} first.` });
        return;
      }
      const best = bestFor(need);
      if (best?.place && best.act) {
        setTold({ id: Date.now(), text: `${best.title}: ${best.detail}` });
        go({ place: best.place, ...best.act, label: best.title });
      } else {
        setTold({ id: Date.now(), text: "Nothing you can get to helps with that right now." });
      }
    },
    closenessOf,
    markOf,
    connected: state.status === "open",
    resources:
      spec && state.snap
        ? spec.resources.map((r, i) => ({ label: r.label, on: state.snap?.resourcesOn[i] === 1 }))
        : [],
    online: state.online,
    roster: state.roster,
    myHandle: handle,
    feed: state.feed,
    chat: state.chat,
    here: placeKey,
    inPlace: Boolean(state.place) && view === "place",
    placeName,
    say: (text) => {
      send({ t: "say", text });
      setWaiting(Date.now());
    },
    replying: waiting !== null,
    // Transcribing takes an account, so a guest gets no microphone rather than one that fails.
    ...(guest
      ? {}
      : {
          hearSpeech: async (wav) => {
            const place = placeKey ? `?place=${encodeURIComponent(placeKey)}` : "";
            const res = await fetch(`/api/worlds/${encodeURIComponent(worldId)}/voice${place}`, {
              method: "POST",
              headers: { "content-type": "audio/wav" },
              body: wav.slice(),
            });
            if (!res.ok) throw new Error("not_heard");
            return ((await res.json()) as { text: string }).text;
          },
        }),
    hold: (agent) => send({ t: "hold", agent }),
    release: () => send({ t: "release" }),
    intent,
    go,
    slots: { life: lifeSlot, plan: planSlot, trip: tripSlot },
    threads: state.threads,
    minute: (clock.day - 1) * 1440 + clock.minuteOfDay,
  };

  const finishTour = () => {
    setTour(null);
    try {
      localStorage.setItem(tourKey(worldId), "1");
    } catch {
      // Private mode: the tour just shows again next time.
    }
  };
  const step = tour === null ? null : city.ui.tour[tour];

  return (
    <div className="game">
      {view === "place" && state.place ? (
        <PlaceView
          key="place"
          game={game}
          place={state.place}
          currency={city.currency}
          settings={bundle.settings}
          myHandle={handle}
          acting={acting ?? state.place.you}
          land={city.theme.colours.land}
          outfits={city.outfits}
          follow={follow}
          controls={camera}
          marks={marks}
          closenessOf={closenessOf}
          onAsk={(object, request) => void ask(object, request)}
          canMove={home === state.place.key || (bundle.yours ?? []).includes(state.place.key)}
          ownCopy={home === state.place.key}
          onUnsavedMoves={setUnsavedMoves}
          onMove={moveThings}
          onPanel={(key) => setPanel({ key, app: null })}
          panelLabel={(key) => panels.find((p) => p.key === key) ?? null}
          onBackend={setBackend}
        />
      ) : (
        <MapView
          key="map"
          city={city}
          places={visiblePlaces({ bundle, home })}
          here={here}
          built={built}
          minuteOfDay={clock.minuteOfDay}
          selected={sheet}
          census={state.census}
          life={lifeOn ? life.frame : null}
          network={network}
          land={land}
          plan={planView}
          onRoad={planning ? setRoad : null}
          onGround={
            pickingSpot
              ? (x, z) => {
                  setFilmSpot([x, z]);
                  setPickingSpot(false);
                }
              : null
          }
          onSelect={planning || pickingSpot ? () => {} : setSheet}
          onBackend={setBackend}
        />
      )}
      <Hud
        layout={view === "place" && state.place ? city.ui.place : city.ui.map}
        ctx={hud}
        toolsOpen={startFilming === true}
        extras={{
          top_left: (
            <button
              type="button"
              className="sys-pill"
              onClick={() => {
                if (okToLeave()) onLeave();
              }}
              title={backend ? `Drawn with ${backend === "webgpu" ? "WebGPU" : "WebGL2"}` : ""}
            >
              ‹ Cities
              {backend && (
                <span className="muted">· {backend === "webgpu" ? "WebGPU" : "WebGL2"}</span>
              )}
            </button>
          ),
          top_right: planning ? null : guest ? (
            <GuestNudge onSaved={(h) => onSaved?.(h)} />
          ) : (
            <FilmPlace
              worldId={worldId}
              cityName={city.name}
              spot={filmSpot}
              startOpen={startFilming === true}
              picking={pickingSpot}
              onPick={(on) => {
                setPickingSpot(on);
                if (on) {
                  setSheet(null);
                  setView("map");
                }
              }}
              onReady={() => {
                setFilmSpot(null);
                void api<CityBundle>(`/worlds/${worldId}/city`)
                  .then(setBundle)
                  .catch(() => undefined);
              }}
              onGo={(place) => go({ place, label: "" })}
            />
          ),
          right: (
            <>
              {!guest &&
                view === "place" &&
                state.place &&
                city.starts.find((s) => s.key === character.start)?.home === state.place.key && (
                  <MakeYours
                    worldId={worldId}
                    place={state.place.key}
                    currency={city.currency}
                    wallet={
                      (yourSlot !== undefined ? state.snap?.wallet[yourSlot] : undefined) ?? 0
                    }
                    buy={(job) => send({ t: "buy_home", job })}
                  />
                )}
              {!guest && (
                <AskPlace
                  worldId={worldId}
                  here={view === "place" ? placeKey : null}
                  placeName={placesOf(city).find((p) => p.key === placeKey)?.name ?? ""}
                  scene={view === "place" ? (state.place?.scene ?? null) : null}
                  suggestions={Object.entries(
                    city.items.find((i) => i.key === placeKey)?.attrs ?? {},
                  ).flatMap(([k, v]) => (k.startsWith("ask_") && typeof v === "string" ? [v] : []))}
                  onMarks={setMarks}
                  onShow={(m) => {
                    // Leaving follow view frames the whole place, on the next render: then turn it.
                    setFollow(false);
                    setTimeout(() => camera.current?.showSpot(m.xMm, m.zMm), 80);
                  }}
                />
              )}
            </>
          ),
          ...(view === "place" && state.place
            ? {
                bottom_left: <Stick onSteer={(x, y) => camera.current?.steer(x, y)} />,
                bottom_right: (
                  <div className="cam-controls" role="toolbar" aria-label="Camera">
                    <button
                      type="button"
                      onClick={() => camera.current?.rotate(-1)}
                      aria-label="Turn the view left"
                    >
                      ⟲
                    </button>
                    <button
                      type="button"
                      onClick={() => setFollow((f) => !f)}
                      aria-label={follow ? "See the whole place" : "Follow me"}
                      title={follow ? "See the whole place" : "Follow me"}
                    >
                      {follow ? "\u{1F5FA}\u{FE0F}" : "\u{1F3A5}"}
                    </button>
                    <button
                      type="button"
                      onClick={() => camera.current?.rotate(1)}
                      aria-label="Turn the view right"
                    >
                      ⟳
                    </button>
                  </div>
                ),
              }
            : {}),
        }}
      />

      {sheet && view === "map" && (
        <PlaceSheet
          {...(sheet && (bundle.removable ?? []).includes(sheet)
            ? { onRemove: () => void removePlace(sheet) }
            : {})}
          marks={city.marks}
          {...(lastMarks.current ? { have: lastMarks.current } : {})}
          earnedBy={(mark) => {
            // Something open to you now first: a way to earn it that's locked too is no help.
            const ways = placesOf(city)
              .filter((p) => !p.private && !p.asks?.length)
              .flatMap((p) =>
                (bundle.catalog[p.key]?.actions ?? [])
                  .filter((a) => a.marks?.includes(mark))
                  .map((a) => ({ a, p })),
              );
            const best = ways.find(({ a }) => !a.asks?.length) ?? ways[0];
            return best ? `${best.a.label} at ${best.p.name}` : null;
          }}
          city={city}
          pacePermille={tripPacePermille(city, bundle.settings)}
          placeKey={sheet}
          here={placeKey}
          built={built.has(sheet)}
          wallet={wallet ?? character.person.money}
          minute={(clock.day - 1) * 1440 + clock.minuteOfDay}
          catalogCount={bundle.catalog[sheet]?.actions.length ?? 0}
          travelling={Boolean(transit)}
          ride={state.place?.ride ?? null}
          then={pending?.place === sheet ? pending.label : null}
          onGo={(m) => {
            send({ t: "go", place: sheet, mode: m });
            setSheet(null);
          }}
          onDrive={() => {
            send({ t: "drive", place: sheet });
            setSheet(null);
          }}
          onEnter={() => {
            setView("place");
            setSheet(null);
          }}
          onClose={() => {
            setSheet(null);
            setPending(null);
          }}
        />
      )}

      {panel && panels.find((p) => p.key === panel.key) && (
        <Panel
          key={panel.key}
          panel={panels.find((p) => p.key === panel.key) as (typeof panels)[number]}
          apps={city.ui.apps}
          initialApp={panel.app}
          onClose={() => setPanel(null)}
          ctx={{
            bundle,
            here,
            home,
            minute: (clock.day - 1) * 1440 + clock.minuteOfDay,
            roster: state.roster,
            online: state.online,
            ...(lastMarks.current ? { marks: lastMarks.current } : {}),
            ...(state.snap && slot !== undefined && spec
              ? {
                  payPermille: emptyCost(
                    spec.needs,
                    (_, j) => state.snap?.needs[slot * spec.needs.length + j] ?? 1,
                  ).payPermille,
                }
              : {}),
            wallet,
            clock,
            name: character.person.name,
            placeName,
            doing,
            needLevel: (need) => needs.find((n) => n.key === need)?.level ?? null,
            intent,
            go,
          }}
        />
      )}

      {step && (
        <div className="modal-back">
          <div className="modal" role="dialog" aria-label={step.title}>
            <h2>{step.title}</h2>
            <p>{step.body}</p>
            <div className="row">
              <button type="button" className="link" onClick={finishTour}>
                Skip
              </button>
              <span className="grow" />
              <span className="muted small">
                {(tour ?? 0) + 1} / {city.ui.tour.length}
              </span>
              <button
                type="button"
                className="primary"
                onClick={() =>
                  (tour ?? 0) + 1 < city.ui.tour.length ? setTour((tour ?? 0) + 1) : finishTour()
                }
              >
                {(tour ?? 0) + 1 < city.ui.tour.length ? "Next" : "Let's go"}
              </button>
            </div>
          </div>
        </div>
      )}

      {asking && (
        <div className="asking" role="status">
          <span className="spinner" aria-hidden /> Seeing about “{asking}”…
        </div>
      )}
      {working && view === "place" && (
        <div className="working" role="status" aria-live="polite">
          <span className="working-label">{working.label}</span>
          <span className="working-bar" aria-hidden>
            <span style={{ width: `${Math.round(working.done * 100)}%` }} />
          </span>
          <span className="muted small">{working.left}</span>
        </div>
      )}
      {view === "map" && !sheet && !transit && state.place && (
        <button type="button" className="sys-pill back-pill" onClick={() => setView("place")}>
          {"\u{21A9}\u{FE0F}"} Back to{" "}
          {placesOf(city).find((p) => p.key === placeKey)?.name ?? state.place.spec.name}
        </button>
      )}
      {billText && !sheet && (
        <div className={`bill-pill ${state.owes > 0 ? "behind" : ""}`} role="status">
          {billText}
        </div>
      )}
      {feeling && view === "place" && (
        <div className="feeling" role="status" aria-live="polite">
          {feeling}
        </div>
      )}
      {state.triumph && (
        <div key={state.triumph.id} className="triumph" role="status">
          <div className="triumph-burst" aria-hidden>
            {"\u{1F389}"}
          </div>
          <div className="triumph-kicker">You did it</div>
          <div className="triumph-title">{state.triumph.title}</div>
          {state.triumph.reward > 0 && (
            <div className="triumph-reward">+{money(state.triumph.reward, city.currency)}</div>
          )}
          <div className="muted small">Something new to work towards is on its way.</div>
          <button type="button" className="primary" onClick={game.dismissTriumph}>
            Carry on
          </button>
        </div>
      )}
      {told && (
        <div key={told.id} className="toast long" role="status">
          {told.text}
        </div>
      )}
      {state.notice && (
        <div key={state.notice.id} className="toast" role="status">
          {state.notice.text}
        </div>
      )}
      {state.status !== "open" && (
        <div className="toast" role="status">
          {state.status === "closed"
            ? state.closedCode === 4000
              ? "You opened this city in another tab."
              : "Disconnected."
            : "Lost touch with the city. Trying to get back…"}
          {state.status === "closed" && (
            <button type="button" className="link" onClick={onLeave}>
              Back
            </button>
          )}
        </div>
      )}
    </div>
  );
}
