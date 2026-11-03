/**
 * The live game, as the realm server reports it: where you are, who is here, the latest
 * snapshot, chat, what's happening, and any trip under way. React state for the interface;
 * snapshots also go straight to subscribers (the renderer) so motion never waits on React.
 */
import { connectRealm, type RealmClient, type RealmStatus, type ThingLayout } from "@aye/engine";
import type {
  ChatLine,
  ClientMessage,
  RosterEntry,
  Scene,
  ServerMessage,
  Snapshot,
  Thread,
  WorldSpec,
} from "@aye/schema";
import type { SimEvent } from "@aye/sim";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, realmUrl } from "../api.ts";
import { money } from "../format.ts";
import { whyNot } from "./why-not.ts";

export interface PlaceState {
  key: string;
  scene: Scene;
  spec: WorldSpec;
  /** Your character's person key here. */
  you: string;
  things: ThingLayout[];
  /** Your own vehicle you could travel in from here, if any. */
  ride: { label: string; speedKmh: number } | null;
}

export interface Transit {
  from: string | null;
  to: string;
  mode: string;
  minutes: number;
  fare: number;
  etaMs: number;
  startedAt: number;
}

/** Something to do here that someone offered you in conversation. */
export interface ChatOffer {
  kind: string;
  action: string;
  label: string;
  cost: number;
  income: number;
}

export interface GameState {
  /** What you're behind on the city's bills, minor units. */
  owes: number;
  status: RealmStatus;
  closedCode: number | null;
  place: PlaceState | null;
  roster: RosterEntry[];
  snap: Snapshot | null;
  chat: (ChatLine & { shownAt: number; offer?: ChatOffer })[];
  feed: { id: number; text: string }[];
  transit: Transit | null;
  online: number;
  /** Players at each public place. */
  census: Record<string, number>;
  notice: { id: number; text: string } | null;
  /** A life goal just reached: the big moment, until it's dismissed. */
  triumph: { id: string; title: string; reward: number } | null;
  /** People out of this place doing something (driving off, gone to work), by person key. */
  out: Record<string, { action: string; thing: string; backAtMinute: number }>;
  /** Your threads in this world: what you're in the middle of (open first). */
  threads: Thread[];
}

const REASONS: Record<string, string> = {
  cannot_afford: "You can't afford that.",
  closed: "It's closed right now.",
  not_running: "That doesn't run at this hour.",
  not_built: "That place is still being built.",
  already_travelling: "You're already on your way somewhere.",
  already_here: "You're already here.",
  taken: "Someone else is playing them.",
  a_player: "That's another player.",
  not_yours: "That isn't yours.",
  no_vehicle: "You don't have a vehicle with you.",
  unreachable: "Can't get there from here.",
  lacks_mark: "You don't have what that takes yet.",
  not_now: "That isn't ready right now (it may be away, off, or need something first).",
  // The world's people make room for players: only other players fill things up.
  full: "Someone else is using that right now.",
  not_offered: "That can't be done here.",
  slow_down: "Slow down a little.",
  unavailable: "That place isn't available.",
  invalid: "That didn't work.",
};

export const reasonText = (code: string) => REASONS[code] ?? "That didn't work.";

let noticeId = 0;
let feedId = 0;

/** Money leaving your pocket stays up long enough to read. */
const BILL_NOTICE_MS = 9_000;
/** Reaching a life goal stays up longer still. */

export function useGame(worldId: string, currency: string, handle?: string) {
  const [state, setState] = useState<GameState>({
    status: "connecting",
    closedCode: null,
    place: null,
    roster: [],
    snap: null,
    chat: [],
    feed: [],
    transit: null,
    online: 0,
    census: {},
    notice: null,
    triumph: null,
    out: {},
    threads: [],
    owes: 0,
  });
  const client = useRef<RealmClient | null>(null);
  /** What each person last started, so leaving can say what they went to do. */
  const lastStarted = useRef(new Map<string, { object: string; action: string }>());
  /** Until when "can't get there" goes unsaid (steering into walls is not news). */
  const quietUntil = useRef(0);
  const snapListeners = useRef(new Set<(s: Snapshot) => void>());
  const live = useRef(state);
  live.current = state;

  // Your threads: read when you join and every half minute (the director hands out new
  // ones between visits); the realm tells you at once when one moves on.
  useEffect(() => {
    let live = true;
    const load = () =>
      api<{ threads: Thread[] }>(`/worlds/${worldId}/threads`)
        .then((r) => {
          if (live) setState((s) => ({ ...s, threads: r.threads }));
        })
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [worldId]);

  useEffect(() => {
    const realm = connectRealm(realmUrl(worldId));
    client.current = realm;
    const patch = (p: Partial<GameState> | ((s: GameState) => Partial<GameState>)) =>
      setState((s) => ({ ...s, ...(typeof p === "function" ? p(s) : p) }));
    let noticeTimer: ReturnType<typeof setTimeout> | null = null;
    // A notice says its piece and goes (gone from the page too, not just faded out).
    const notify = (text: string, showMs = 4_000) => {
      const id = ++noticeId;
      patch({ notice: { id, text } });
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = setTimeout(
        () => patch((s) => (s.notice?.id === id ? { notice: null } : {})),
        showMs,
      );
    };

    const nameOf = (key: string) =>
      live.current.roster.find((r) => r.key === key)?.person.name ?? "Someone";
    const actionLabel = (object: string, action: string) => {
      const spec = live.current.place?.spec;
      const kind = spec?.things.find((t) => t.object === object)?.kind;
      const k = spec?.kinds.find((x) => x.key === kind);
      return {
        action: k?.actions.find((a) => a.key === action)?.label ?? action,
        thing: k?.label ?? "",
      };
    };
    const describe = (e: SimEvent): string | null => {
      switch (e.type) {
        case "action_started": {
          const { action, thing } = actionLabel(e.object, e.action);
          // "Cook on kerosene stove" already says what with; only name the thing if not.
          const said = action.toLowerCase();
          const named =
            thing &&
            !thing
              .toLowerCase()
              .split(/\s+/)
              .some((w) => w.length > 2 && said.includes(w));
          return `${nameOf(e.agent)} · ${action}${named ? ` · ${thing}` : ""}${e.paid ? ` · −${money(e.paid, currency)}` : ""}`;
        }
        case "action_finished":
          return e.earned > 0 ? `${nameOf(e.agent)} · +${money(e.earned, currency)}` : null;
        case "left":
          return `${nameOf(e.agent)} went out${e.object ? ` with the ${actionLabel(e.object, "").thing.toLowerCase() || "thing"}` : ""}`;
        case "returned":
          return `${nameOf(e.agent)} is back`;
        case "resource_changed": {
          const r = live.current.place?.spec.resources.find((x) => x.key === e.resource);
          return `${r?.label ?? e.resource} ${e.on ? "is back" : "went off"}`;
        }
        case "arrived":
          return `${nameOf(e.agent)} arrived`;
        default:
          return null;
      }
    };

    const offs = [
      realm.onStatus((status, code) =>
        patch({ status, closedCode: status === "closed" ? (code ?? null) : null }),
      ),
      realm.on("place", (m) =>
        patch((s) => {
          // The same place again (it was extended live): keep the conversation going.
          const same = s.place?.key === m.place;
          return {
            place: {
              key: m.place,
              scene: m.scene as Scene,
              spec: m.spec as WorldSpec,
              you: m.you,
              things: m.things,
              ride: m.ride ?? null,
            },
            transit: null,
            ...(same ? {} : { snap: null, feed: [], out: {} }),
            chat: same ? s.chat : m.chat.map((c) => ({ ...c, shownAt: 0 })),
          };
        }),
      ),
      realm.on("roster", (m) => patch({ roster: m.roster })),
      realm.on("thread", (m) => {
        const t = m.thread;
        const before = live.current.threads.find((x) => x.id === t.id);
        patch((s) => ({
          threads: [t, ...s.threads.filter((x) => x.id !== t.id)].sort(
            (a, b) => Number(b.state === "open") - Number(a.state === "open"),
          ),
        }));
        if (t.state === "done" && t.aim) {
          // The big one: it took a while, so it gets a moment.
          patch({ triumph: { id: t.id, title: t.title, reward: t.reward } });
        } else if (t.state === "open" && before && t.progress > before.progress) {
          // A step of something bigger: it shouldn't just quietly turn into the next one.
          const done = before.steps[t.progress - 1];
          if (done) notify(`\u{2705} ${done.text}`);
        } else if (t.state === "done") {
          notify(
            `\u{2705} ${t.title}${t.reward > 0 ? ` \u{00B7} +${money(t.reward, currency)}` : ""}`,
          );
        } else if (t.state === "missed") {
          notify(`\u{231B} Out of time: ${t.title}`);
        }
      }),
      realm.on("ride", (m) =>
        patch((s) => (s.place ? { place: { ...s.place, ride: m.ride } } : {})),
      ),
      realm.on("snap", (m) => {
        const { t: _, ...snap } = m;
        if (snap.shut === 1 && live.current.snap?.shut === 0) {
          notify("This place has closed. Paid work and buying stop until it opens.");
        }
        for (const l of snapListeners.current) l(snap);
        patch({ snap });
      }),
      realm.on("events", (m) => {
        const events = m.events as SimEvent[];
        const { place, roster } = live.current;
        const mine = (agent: string) =>
          agent === place?.you ||
          (handle !== undefined && roster.find((r) => r.key === agent)?.heldBy === handle);
        // The server only sends rejections of your own commands (or the person you hold's).
        for (const e of events) {
          // How it turned out is news to whoever did it; everyone hears all the sim's events.
          if (e.type === "action_finished" && mine(e.agent)) {
            // What it really paid, which can differ from the menu: how it went, how you were.
            const paid =
              e.earned !== 0
                ? `${e.earned > 0 ? "+" : "-"}${money(Math.abs(e.earned), currency)}`
                : "";
            const short = e.docked
              ? ` (${money(e.docked, currency)} less for running on empty)`
              : "";
            // Holding someone, what they earn is theirs: say whose it is.
            const whose =
              e.agent === place?.you
                ? ""
                : `${roster.find((r) => r.key === e.agent)?.person.name ?? "They"}: `;
            if (e.say) notify(`${whose}${paid ? `${e.say} ${paid}${short}` : e.say}`);
            else if (paid) notify(`${whose}${paid}${short}`);
            else if (e.practiceMissed) notify("Nothing new this time. Practice takes a few goes.");
          }
          // Walking off a job forfeits it: what it cost is gone and nothing's paid. Say so.
          if (e.type === "action_interrupted" && e.reason === "cancelled" && mine(e.agent)) {
            const def = place?.spec.kinds.flatMap((k) => k.actions).find((a) => a.key === e.action);
            if (def && (def.cost > 0 || def.income > 0)) {
              notify(
                `You stopped: ${def.label}.${def.income > 0 ? " No pay for it." : def.cost > 0 ? " The money's spent." : ""}`,
              );
            }
          }
          // Stopped by the world (the power went, the thing's run out): never silently.
          if (e.type === "action_interrupted" && e.reason === "conditions" && mine(e.agent)) {
            const def = place?.spec.kinds.flatMap((k) => k.actions).find((a) => a.key === e.action);
            const snap = live.current.snap;
            const slot = roster.find((r) => r.key === e.agent)?.slot;
            const why =
              place && def && snap && slot !== undefined
                ? whyNot({
                    place,
                    thing: e.object,
                    action: def,
                    snap,
                    slot,
                    acting: e.agent,
                    roster,
                    wallet: snap.wallet[slot] ?? 0,
                  })
                : null;
            if (def) {
              const paid =
                def.income > 0 ? " No pay for it." : def.cost > 0 ? " The money's spent." : "";
              notify(`${def.label} stopped: ${why ?? "something it needs ran out"}.${paid}`);
            }
          }
          if (e.type !== "command_rejected") continue;
          if (e.reason === "unreachable" && performance.now() < quietUntil.current) continue;
          notify(reasonText(e.reason));
        }
        const lines = events
          .map(describe)
          .filter((x): x is string => x !== null)
          .map((text) => ({ id: ++feedId, text }));
        if (lines.length > 0)
          patch((s) => ({ feed: [...lines.reverse(), ...s.feed].slice(0, 40) }));
        // Who is out, and until when (city minutes), so the game can say so.
        const now = live.current.snap?.clock;
        const at = now ? now.day * 1440 + now.minuteOfDay : 0;
        const outNow = { ...live.current.out };
        let changed = false;
        for (const e of events) {
          if (e.type === "action_started") {
            lastStarted.current.set(e.agent, { object: e.object, action: e.action });
          } else if (e.type === "left") {
            const started = lastStarted.current.get(e.agent);
            const labels = started ? actionLabel(started.object, started.action) : null;
            outNow[e.agent] = {
              action: labels?.action ?? "",
              thing: e.object ? actionLabel(e.object, "").thing : "",
              backAtMinute: at + e.minutes,
            };
            changed = true;
          } else if (e.type === "returned" && outNow[e.agent]) {
            delete outNow[e.agent];
            changed = true;
          }
        }
        if (changed) patch({ out: outNow });
      }),
      realm.on("transit", (m) =>
        patch({
          transit: { ...m, startedAt: performance.now() },
          place: null,
          roster: [],
          snap: null,
        }),
      ),
      realm.on("said", (m) => {
        if (m.warmth) {
          notify(
            m.warmth > 0
              ? `\u{1F91D} ${m.line.from} warms to you`
              : `\u{1F624} ${m.line.from} has gone off you`,
          );
        }
        patch((s) => ({
          chat: [
            ...s.chat,
            { ...m.line, shownAt: performance.now(), ...(m.offer ? { offer: m.offer } : {}) },
          ].slice(-60),
        }));
      }),
      realm.on("presence", (m) => patch({ online: m.online, census: m.places })),
      realm.on("refused", (m) => notify(reasonText(m.reason))),
      realm.on("bills", (m) => {
        patch({ owes: m.owes });
        if (m.paid > 0) {
          const what = m.names.length > 0 ? m.names.join(", ") : "What you owed";
          notify(`\u{1F4B8} ${what} \u{00B7} -${money(m.paid, currency)}`, BILL_NOTICE_MS);
        } else if (m.names.length > 0) {
          notify(`\u{1F4B8} ${m.names.join(", ")} due, and you can't cover it`, BILL_NOTICE_MS);
        }
      }),
      realm.on("selfCare", (m) => {
        if (m.on)
          notify("You went quiet, so you're looking after yourself. Move or tap to take over.");
      }),
    ];
    return () => {
      for (const off of offs) off();
      if (noticeTimer) clearTimeout(noticeTimer);
      realm.close();
      client.current = null;
    };
  }, [worldId, currency]);

  const actions = useMemo(
    () => ({
      send: (message: ClientMessage) => client.current?.send(message),
      dismissTriumph: () => setState((s) => ({ ...s, triumph: null })),
      quiet(ms: number) {
        quietUntil.current = performance.now() + ms;
      },
      onSnap(listener: (s: Snapshot) => void): () => void {
        snapListeners.current.add(listener);
        return () => {
          snapListeners.current.delete(listener);
        };
      },
    }),
    [],
  );
  return { state, ...actions };
}

export type Game = ReturnType<typeof useGame>;
/** Messages the server may send, re-exported for components. */
export type { ServerMessage };
