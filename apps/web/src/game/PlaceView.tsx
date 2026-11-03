/**
 * Inside a place: the engine draws it from the server's snapshots; the DOM floats what people
 * say over their heads, names over players, a menu of what a tapped thing can do (greyed when
 * its conditions don't hold right now), and a card for a tapped person (take them over).
 * Tapping the floor walks there; WASD, the arrow keys or the stick steer. Everything is an
 * intent; the server decides.
 */
import { createRenderer, type Renderer } from "@aye/engine";
import {
  type ActionDef,
  type ClientCommand,
  emptyCost,
  heldActionTicks,
  type RosterEntry,
  type WorldSettings,
} from "@aye/schema";
import { type MutableRefObject, type PointerEvent, useEffect, useRef, useState } from "react";
import { durationText, money } from "../format.ts";

/** How long it really takes to watch, for someone being played: long things are sped up. */
function heldSeconds(action: { durationMin: number }, settings: WorldSettings): number {
  return Math.ceil(heldActionTicks(action, settings) / settings.ticksPerRealSecond);
}

/**
 * What the clock does differs: something sped up to fit does the good of its whole length without
 * that much time going by (a night's sleep doesn't bring the morning), so it says "worth".
 */
function heldText(action: ActionDef, settings: WorldSettings): string {
  const seconds = heldSeconds(action, settings);
  const sped = heldActionTicks(action, settings) < action.durationMin * 60;
  return sped
    ? `${seconds}s, worth ${durationText(action.durationMin)}`
    : `${durationText(action.durationMin)} in ${seconds}s`;
}

import { COMPACT_QUERY } from "./Hud.tsx";
import { useSteering } from "./movement.ts";
import { StillDrawing } from "./StillDrawing.tsx";
import type { Game, PlaceState } from "./useGame.ts";
import { whyNot } from "./why-not.ts";

const BUBBLE_MS = 6_000;

/** What the HUD's camera buttons can do to this view. */
export interface CameraControls {
  rotate(eighthTurns: number): void;
  /** Steer as a stick would: x right, y forward, each -1..1; 0, 0 stops. */
  steer(x: number, y: number): void;
  /** Bring a spot in the place into view. */
  showSpot(xMm: number, zMm: number): void;
}

const EDGE_PX = 8;
/** Room left for the clock and the bar along the top of the screen. */
/** Room above a menu when the HUD's top row can't be measured. */
const HUD_TOP_PX = 76;
const clampTo = (v: number, least: number, most: number) => Math.max(least, Math.min(most, v));

export function PlaceView({
  game,
  place,
  currency,
  settings,
  myHandle,
  acting,
  land,
  marks,
  closenessOf,
  outfits,
  follow,
  controls,
  onAsk,
  onPanel,
  panelLabel,
  onBackend,
}: {
  game: Game;
  place: PlaceState;
  currency: string;
  settings: WorldSettings;
  myHandle: string;
  /** Who your taps command: your character's key, or the person you hold. */
  acting: string;
  /** The city's land colour, for the ground around the place. */
  land: string;
  /** The city's outfits, for people made before it had them. */
  outfits: readonly string[];
  /** Keep the camera on whoever you're playing (else the whole place). */
  follow: boolean;
  controls: MutableRefObject<CameraControls | null>;
  /** Spots to point out in the place (what an answer is about). */
  marks?: readonly { xMm: number; zMm: number; radiusMm: number }[];
  closenessOf(person: string): number;
  /** Ask a thing for something it can't do yet. */
  onAsk(object: string, request: string): void;
  /** Open one of the city's panels (a thing here that is one was tapped). */
  onPanel(key: string): void;
  panelLabel(key: string): { label: string; icon: string } | null;
  onBackend(backend: string): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [thing, setThing] = useState<string | null>(null);
  const [person, setPerson] = useState<number | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const { state, send } = game;
  const roster = state.roster;
  const rosterRef = useRef(roster);
  rosterRef.current = roster;
  const actingRef = useRef(acting);
  actingRef.current = acting;

  const command = (cmd: ClientCommand) =>
    send({ t: "do", cmd, ...(actingRef.current !== place.you ? { as: actingRef.current } : {}) });

  // The HUD's stick steers through the controls; this points at the live steering.
  const steerRef = useRef<((x: number, y: number) => void) | null>(null);
  useEffect(() => {
    let disposed = false;
    let frame = 0;
    void createRenderer(canvas.current as HTMLCanvasElement, {
      artifactUrl: (hash) => `/api/artifacts/${encodeURIComponent(hash)}`,
    }).then((r) => {
      if (disposed) return r.dispose();
      renderer.current = r;
      controls.current = {
        rotate: (n) => r.rotate(n),
        steer: (x, y) => steerRef.current?.(x, y),
        showSpot: (x, z) => r.showSpot(x, z),
      };
      onBackend(r.backend);
      r.onSelect((id) => {
        setThing(id);
        setPerson(null);
      });
      r.onHover(setHovered);
      r.onPerson((slot) => {
        setPerson(slot);
        setThing(null);
      });
      r.onGround((x, z) => {
        setThing(null);
        setPerson(null);
        command({ type: "walk", x, z });
      });
      setReady(true);
      // On a phone a menu is a sheet from the bottom, wherever its thing or person is.
      const phone = globalThis.matchMedia(COMPACT_QUERY);
      const asSheet = (el: HTMLElement) => {
        if (!phone.matches || !el.classList.contains("menu")) return false;
        el.style.display = "";
        el.style.transform = "";
        return true;
      };
      // Overlays follow the camera every frame without React renders.
      const tick = () => {
        const host = overlay.current;
        if (host) {
          for (const el of host.querySelectorAll<HTMLElement>("[data-slot]")) {
            if (asSheet(el)) continue;
            const at = r.screenOfPerson(Number(el.dataset["slot"]));
            el.style.display = at ? "" : "none";
            if (!at) continue;
            // Someone's card stays whole on screen too, wherever they walk.
            const x = el.classList.contains("menu")
              ? clampTo(
                  at.x,
                  el.offsetWidth / 2 + EDGE_PX,
                  host.clientWidth - el.offsetWidth / 2 - EDGE_PX,
                )
              : at.x;
            const y = el.classList.contains("menu")
              ? clampTo(at.y, el.offsetHeight + HUD_TOP_PX, host.clientHeight - EDGE_PX)
              : at.y;
            el.style.transform = `translate(${x}px, ${y}px)`;
          }
          for (const el of host.querySelectorAll<HTMLElement>("[data-thing]")) {
            if (asSheet(el)) continue;
            const at = r.screenOfThing(el.dataset["thing"] as string);
            el.style.display = at ? "" : "none";
            if (!at) continue;
            // A menu stays whole on screen, clear of the clock, wherever its thing is.
            const menu = el.classList.contains("menu");
            const x = menu
              ? clampTo(
                  at.x,
                  el.offsetWidth / 2 + EDGE_PX,
                  host.clientWidth - el.offsetWidth / 2 - EDGE_PX,
                )
              : at.x;
            const y = menu
              ? clampTo(
                  at.y,
                  el.offsetHeight +
                    (document.querySelector(".r-top")?.getBoundingClientRect().bottom ??
                      HUD_TOP_PX) +
                    EDGE_PX,
                  host.clientHeight - EDGE_PX,
                )
              : at.y;
            el.style.transform = `translate(${x}px, ${y}px)`;
          }
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      renderer.current?.dispose();
      renderer.current = null;
      controls.current = null;
    };
    // The renderer lives as long as the view; place changes reload it below.
  }, [onBackend, controls]);

  const loadedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    // The same place again (extended live) keeps the view; a new place is framed afresh.
    const same = loadedKey.current === place.key;
    loadedKey.current = place.key;
    renderer.current?.loadScene(place.scene, place.spec, {
      things: place.things,
      resources: place.spec.resources.map((r) => r.key),
      keepCamera: same,
    });
    if (!same) {
      setThing(null);
      setPerson(null);
    }
  }, [ready, place]);

  useEffect(() => {
    const r = renderer.current;
    if (!ready || !r) return;
    const slots: (RosterEntry["person"] | null)[] = new Array(32).fill(null);
    for (const e of roster) slots[e.slot] = dressed(e.person, outfits);
    r.setPeople(slots);
    r.setYou(roster.find((e) => e.key === acting)?.slot ?? null);
  }, [ready, roster, acting, outfits]);

  // Follow whoever you're playing (once they're here), or look at the whole place.
  const actingSlotNow = roster.find((e) => e.key === acting)?.slot ?? null;
  useEffect(() => {
    if (ready) renderer.current?.follow(follow ? actingSlotNow : null);
  }, [ready, follow, actingSlotNow]);

  useEffect(
    () =>
      game.onSnap((s) => {
        const r = renderer.current;
        if (!r) return;
        r.setAgents({
          positions: Float32Array.from(s.positions),
          modes: Uint8Array.from(s.modes),
          poses: Uint8Array.from(s.poses),
          using: s.using ?? [],
          on: Uint8Array.from(s.on ?? []),
        });
        r.setTime(devTime() ?? s.clock.minuteOfDay);
        r.setState({
          thingVars: Int32Array.from(s.thingVars),
          thingAway: Uint8Array.from(s.thingAway),
          resourcesOn: Uint8Array.from(s.resourcesOn),
        });
      }),
    [game.onSnap],
  );

  const steering = useSteering(
    ready ? renderer.current : null,
    actingSlotNow,
    (x, z) => command({ type: "walk", x, z }),
    () => {
      // Steering into a wall shouldn't shout; and a menu left open would be in the way.
      game.quiet(600);
      setThing(null);
      setPerson(null);
    },
  );
  steerRef.current = (x, y) => steering.setStick(x, y);

  useEffect(() => renderer.current?.setSelected(thing), [thing]);
  useEffect(() => {
    if (ready) renderer.current?.setMarks(marks ?? []);
  }, [marks, ready]);

  // Development only: lets automated play-testing find and tap things like a player would.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const hook = {
      things: () =>
        place.scene.objects.map((o) => ({
          id: o.id,
          label: o.label,
          kind: place.spec.kinds.find(
            (k) => k.key === place.spec.things.find((t) => t.object === o.id)?.kind,
          )?.label,
          at: renderer.current?.screenOfThing(o.id) ?? null,
        })),
      tap: (id: string) => {
        setThing(id);
        setPerson(null);
      },
    };
    (globalThis as Record<string, unknown>)["__ayePlace"] = hook;
    return () => {
      delete (globalThis as Record<string, unknown>)["__ayePlace"];
    };
  }, [place]);
  useEffect(() => {
    if (ready) renderer.current?.setSurroundings(land);
  }, [ready, land]);

  const snap = state.snap;
  const now = performance.now();
  const slotOf = new Map(roster.map((r) => [r.key, r.slot]));
  const bubbles = state.chat.filter((c) => c.agent && now - c.shownAt < BUBBLE_MS && c.shownAt > 0);
  const actingSlot = slotOf.get(acting);
  const wallet = snap && actingSlot !== undefined ? (snap.wallet[actingSlot] ?? 0) : 0;

  // What the tapped thing can do.
  const obj = place.scene.objects.find((o) => o.id === thing);
  const def = place.spec.things.find((t) => t.object === thing);
  const kind = place.spec.kinds.find((k) => k.key === def?.kind);
  const layout = place.things.find((t) => t.id === thing);
  // What work pays you just now, as the sim will pay it.
  const payShare = snap
    ? emptyCost(
        place.spec.needs,
        (_, j) => snap.needs[(actingSlot ?? 0) * place.spec.needs.length + j] ?? 1,
      ).payPermille
    : 1000;
  const why = (a: ActionDef): string | null =>
    snap
      ? whyNot({ place, thing, action: a, snap, slot: actingSlot ?? 0, acting, roster, wallet })
      : "\u2026";
  const tapped = person === null ? null : roster.find((r) => r.slot === person);

  return (
    <div className="stage">
      {!ready && <StillDrawing />}
      <canvas ref={canvas} className="stage-canvas" aria-label={place.spec.name} />
      <div className="overlay" ref={overlay}>
        {roster
          .filter((r) => r.player || r.heldBy)
          .map((r) => (
            <div key={`tag-${r.key}`} className="tag" data-slot={r.slot}>
              {r.person.name}
            </div>
          ))}
        {bubbles.map((c) => {
          const slot = slotOf.get(c.agent as string);
          return slot === undefined ? null : (
            <div key={c.id} className="bubble" data-slot={slot}>
              {c.text}
            </div>
          );
        })}
        {hovered &&
          hovered !== thing &&
          (() => {
            const k = place.spec.kinds.find(
              (x) => x.key === place.spec.things.find((t) => t.object === hovered)?.kind,
            );
            return k ? (
              <div className="hover-tag" data-thing={hovered}>
                {k.label}
              </div>
            ) : null;
          })()}
        {kind && obj && (
          <div className="menu" data-thing={obj.id} role="dialog" aria-label={kind.label}>
            <div className="menu-head">
              <strong>{kind.label}</strong>
              <button
                type="button"
                className="link"
                onClick={() => setThing(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            {kind.vars.length > 0 && snap && layout && (
              <div className="menu-state">
                {kind.vars.map((v, i) => {
                  // Yes or no reads; a bare number ("Wash state: 0") tells a player nothing.
                  if (v.max !== 1) return null;
                  const value = snap.thingVars[layout.base + i] ?? 0;
                  return (
                    <span key={v.key} className="chip">
                      {v.label}: {value ? "yes" : "no"}
                    </span>
                  );
                })}
              </div>
            )}
            {kind.panel &&
              (() => {
                const p = panelLabel(kind.panel);
                return p ? (
                  <button
                    type="button"
                    className="menu-action"
                    onClick={() => {
                      onPanel(kind.panel as string);
                      setThing(null);
                    }}
                  >
                    <span className="grow">
                      <span aria-hidden>{p.icon}</span> {p.label}
                    </span>
                  </button>
                ) : null;
              })()}
            {kind.actions.map((a) => {
              const blocked = why(a);
              return (
                <button
                  key={a.key}
                  type="button"
                  className="menu-action"
                  disabled={blocked !== null}
                  title={blocked ?? undefined}
                  onClick={() => {
                    command({ type: "use", object: obj.id, action: a.key });
                    setThing(null);
                  }}
                >
                  <span className="grow">{a.label}</span>
                  <span className="muted small">
                    {heldText(a, settings)}
                    {(a.marks ?? []).map((m) => {
                      const label =
                        place.spec.marks?.find((x) => x.key === m.mark)?.label ?? m.mark;
                      // Practice takes time, so what's free to try builds a skill rather than promising it.
                      if (m.by > 0 && a.cost === 0) return ` · builds ${label}`;
                      return ` · ${m.by > 0 ? "+" : ""}${m.by} ${label}`;
                    })}
                    {a.cost > 0 && ` · ${money(a.cost, currency)}`}
                    {a.income > 0 && (
                      <span className="t-good">
                        {" "}
                        · +{money(Math.floor((a.income * payShare) / 1000), currency)}
                      </span>
                    )}
                    {blocked && ` · ${blocked}`}
                  </span>
                </button>
              );
            })}
            <AskBox onAsk={(request) => onAsk(obj.id, request)} />
          </div>
        )}
        {tapped && (
          <div
            className="menu"
            data-slot={tapped.slot}
            role="dialog"
            aria-label={tapped.person.name}
          >
            <div className="menu-head">
              <strong>{tapped.person.name}</strong>
              <button
                type="button"
                className="link"
                onClick={() => setPerson(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="muted small">{tapped.person.about}</div>
            {tapped.key !== place.you && closenessOf(tapped.key) > 0 && (
              <div className="small">
                {"\u{1F91D}"} Knows you: {closenessOf(tapped.key)} of 10
              </div>
            )}
            {tapped.key === place.you ? (
              <div className="small">That's you.</div>
            ) : tapped.player ? (
              <div className="small">Played by @{tapped.player}</div>
            ) : tapped.heldBy === myHandle ? (
              <button type="button" className="menu-action" onClick={() => send({ t: "release" })}>
                Let go of {tapped.person.name}
              </button>
            ) : tapped.heldBy ? (
              <div className="small">Played by @{tapped.heldBy}</div>
            ) : (
              <button
                type="button"
                className="menu-action"
                onClick={() => send({ t: "hold", agent: tapped.key })}
              >
                Play as {tapped.person.name}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AskBox({ onAsk }: { onAsk(request: string): void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="ask"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim().length < 2) return;
        onAsk(text.trim());
        setText("");
      }}
    >
      <input
        value={text}
        maxLength={300}
        onChange={(e) => setText(e.target.value)}
        placeholder="Something else?"
        aria-label="Ask what else this can do"
      />
      <button type="submit" className="mini" disabled={text.trim().length < 2}>
        Ask
      </button>
    </form>
  );
}

/** Development only: `#time=12:00` in the address fixes the light, to look at a place by day. */
function devTime(): number | null {
  if (!import.meta.env.DEV) return null;
  const m = /time=(\d{1,2}):(\d{2})/.exec(location.hash);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * An on-screen stick (touch or mouse): push to steer, let go to stop. Part of the HUD's own
 * layout (placed in a region like any control), so it never covers what the city put there.
 */
export function Stick({ onSteer }: { onSteer(x: number, y: number): void }) {
  const knob = useRef<HTMLDivElement>(null);
  const origin = useRef<{ x: number; y: number; r: number } | null>(null);
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const o = origin.current;
    if (!o) return;
    let dx = (e.clientX - o.x) / o.r;
    let dy = (e.clientY - o.y) / o.r;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    if (knob.current) {
      knob.current.style.transform = `translate(${dx * o.r * 0.6}px, ${dy * o.r * 0.6}px)`;
    }
    onSteer(dx, -dy);
  };
  const end = () => {
    origin.current = null;
    if (knob.current) knob.current.style.transform = "";
    onSteer(0, 0);
  };
  return (
    <div
      className="stick"
      role="application"
      aria-label="Move (or use W A S D)"
      onPointerDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        origin.current = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          r: rect.width / 2,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e);
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <div className="stick-knob" ref={knob} />
    </div>
  );
}

/**
 * Someone made before their city had outfits wears one of its outfits, the same one every
 * time (picked from their key). Presentation only: the list is the city's own choice.
 */
function dressed(person: RosterEntry["person"], outfits: readonly string[]): RosterEntry["person"] {
  if (person.outfit || outfits.length === 0) return person;
  let h = 0;
  for (const c of person.key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { ...person, outfit: outfits[h % outfits.length] as string };
}
