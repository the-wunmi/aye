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
  type ObjectId,
  type RosterEntry,
  type Scene,
  type WorldSettings,
} from "@aye/schema";
import {
  canBeMoved,
  carriedBy,
  footingCheck,
  type MoveOf,
  moveThing,
  moveThings,
  standingCheck,
} from "@aye/sim";
import {
  type MutableRefObject,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
/** How long to wait for the room to take a saved move, a tenth of a second at a time. */
const ROOM_TAKES_MOVE_POLLS = 150;
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
  canMove,
  ownCopy,
  onUnsavedMoves,
  onMove,
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
  /** This place is yours to rearrange. */
  canMove: boolean;
  /** It's your own private copy of it: nobody else will see what you change. */
  ownCopy: boolean;
  /** Whether there are moves not saved yet, for asking before they're lost. */
  onUnsavedMoves(any: boolean): void;
  /** Save everything moved; true if the place took it. */
  onMove(moves: MoveOf[]): Promise<boolean>;
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
  /** What was last tapped while rearranging, for turning; and whether a move is being saved. */
  const [pointedAt, setPointedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  /** Why the last move couldn't be made. */
  const [cantBecause, setCantBecause] = useState<string | null>(null);
  /**
   * The rearrangement so far, nothing of it saved: each step, and the room before it, for undoing.
   * In a ref because a drag reads it mid-gesture; `drafted` is what makes the buttons follow it.
   */
  const draft = useRef<{ before: Scene; move: MoveOf }[]>([]);
  const draftScene = useRef<Scene | null>(null);
  const [drafted, setDrafted] = useState(0);
  /** Rearranging: everything movable is marked, and tapping one picks it up. */
  const [arranging, setArranging] = useState(false);
  const arrangingRef = useRef(arranging);
  arrangingRef.current = arranging;
  const dropRef = useRef<(id: ObjectId, to: { xMm: number; zMm: number; yawDeg: number }) => void>(
    () => undefined,
  );
  const placeRef = useRef(place);
  placeRef.current = place;
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
        if (arrangingRef.current) {
          setCantBecause(null);
          setPointedAt(id);
          return;
        }
        setThing(id);
        setPerson(null);
      });
      r.onHover(setHovered);
      r.onDrop((id, to) => dropRef.current(id as ObjectId, to));
      r.onPerson((slot) => {
        if (arrangingRef.current) return;
        setPerson(slot);
        setThing(null);
      });
      r.onGround((x, z) => {
        if (arrangingRef.current) return;
        setThing(null);
        setPerson(null);
        command({ type: "walk", x, z });
      });
      r.setPlacementCheck((id) => {
        const { scene: saved, spec } = placeRef.current;
        const scene = draftScene.current ?? saved;
        const check = standingCheck(scene, spec, id as ObjectId);
        return check && ((xMm, zMm, yawDeg) => check({ xMm, zMm, yawDeg }) === null);
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
    // Someone else changed the place mid-rearrangement: what's been done so far goes on top of it.
    let shown = place.scene;
    if (same && !savingRef.current && draft.current.length > 0) {
      const again = draft.current.map((d) => d.move);
      const replayed = moveThings(place.scene, place.spec, again);
      if (replayed.ok) {
        shown = replayed.scene;
        draftScene.current = replayed.scene;
      } else {
        draft.current = [];
        draftScene.current = null;
        setDrafted(0);
      }
    }
    renderer.current?.loadScene(shown, place.spec, {
      things: place.things,
      resources: place.spec.resources.map((r) => r.key),
      keepCamera: same,
    });
    if (!same) {
      draft.current = [];
      draftScene.current = null;
      setDrafted(0);
      setArranging(false);
      setPointedAt(null);
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

  useEffect(() => {
    onUnsavedMoves(drafted > 0);
    return () => onUnsavedMoves(false);
  }, [drafted, onUnsavedMoves]);

  // Everything that can be moved stays highlighted while rearranging, and pressing it picks it up.
  useEffect(() => {
    const r = renderer.current;
    if (!ready || !r) return;
    if (!arranging) {
      r.setRearranging(null);
      r.setMovable([]);
      return;
    }
    const now = () => draftScene.current ?? placeRef.current.scene;
    const can = new Set(place.scene.objects.filter(canBeMoved).map((o) => o.id as string));
    r.setRearranging({
      // Something resting on another thing moves it: the TV is how you'd grab what it stands on.
      grab(id) {
        if (savingRef.current) return null;
        if (can.has(id)) return id;
        for (const base of can) {
          if (carriedBy(now(), base as ObjectId).some((o) => o.id === id)) return base;
        }
        return null;
      },
      carried: (id) => carriedBy(now(), id as ObjectId).map((o) => o.id),
    });
    r.setMovable([...can]);
  }, [ready, arranging, place, drafted]);

  // Follow whoever you're playing (once they're here), or look at the whole place.
  const actingSlotNow = roster.find((e) => e.key === acting)?.slot ?? null;
  useEffect(() => {
    // Placing something needs the whole room in view, not the back of your own head.
    if (ready) renderer.current?.follow(follow && !arranging ? actingSlotNow : null);
  }, [ready, follow, actingSlotNow, arranging]);

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

  const footing = useMemo(
    () => footingCheck(place.scene, place.spec, settings.gridCellMm),
    [place.scene, place.spec, settings.gridCellMm],
  );
  useEffect(() => {
    if (ready) renderer.current?.setFooting(footing);
  }, [ready, footing]);
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
    () => {
      const entry = roster.find((e) => e.key === acting);
      const base = entry?.person.body.speedMmPerS ?? 1_200;
      const snap = state.snap;
      const slot = entry?.slot;
      if (!snap || slot === undefined) return base;
      const count = place.spec.needs.length;
      const { walkPermille } = emptyCost(
        place.spec.needs,
        (_, j) => snap.needs[slot * count + j] ?? 1,
      );
      return (base * walkPermille) / 1000;
    },
    footing,
  );
  steerRef.current = (x, y) => steering.setStick(x, y);

  // While rearranging, the ring is on what was last tapped.
  useEffect(() => {
    renderer.current?.setSelected(arranging ? pointedAt : thing);
  }, [thing, arranging, pointedAt, drafted]);
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

  const nameOf = (id: string) => {
    const kind = place.spec.things.find((t) => t.object === id)?.kind;
    return (
      place.spec.kinds.find((k) => k.key === kind)?.label ??
      place.scene.objects.find((o) => o.id === id)?.label ??
      "Something"
    );
  };
  /** Try a thing here, in the draft: the same check the server will make when it's saved. */
  const tryMove = (id: ObjectId, to: { xMm: number; zMm: number; yawDeg: number }) => {
    const r = renderer.current;
    if (!r || savingRef.current) return;
    const before = draftScene.current ?? place.scene;
    const m = moveThing(before, place.spec, id, to);
    if (!m.ok) {
      // Back where it stood, and whatever came along with it.
      const riders = carriedBy(before, id);
      const self = before.objects.filter((o) => o.id === id);
      r.placeThings([...self, ...riders]);
      setCantBecause(m.reason);
      r.setMovable(place.scene.objects.filter(canBeMoved).map((o) => o.id));
      r.setSelected(pointedAt);
      return;
    }
    setCantBecause(null);
    draft.current = [...draft.current, { before, move: { object: id, ...to } }];
    draftScene.current = m.scene;
    r.placeThings(m.moved);
    setPointedAt(id);
    setDrafted(draft.current.length);
  };
  dropRef.current = tryMove;
  const turn = () => {
    const o = (draftScene.current ?? place.scene).objects.find((x) => x.id === pointedAt);
    if (!o) return;
    const [xMm = 0, , zMm = 0] = o.transform.position;
    tryMove(o.id, { xMm, zMm, yawDeg: (Math.round(o.transform.yawDeg) + 45) % 360 });
  };
  const undo = () => {
    const last = draft.current.at(-1);
    const now = draftScene.current;
    if (!last || !now || savingRef.current) return;
    const changed = last.before.objects.filter((o) => {
      const here = now.objects.find((x) => x.id === o.id);
      return here && JSON.stringify(here.transform) !== JSON.stringify(o.transform);
    });
    renderer.current?.placeThings(changed);
    draft.current = draft.current.slice(0, -1);
    draftScene.current = draft.current.length > 0 ? last.before : null;
    setCantBecause(null);
    setDrafted(draft.current.length);
  };
  const leaveRearranging = () => {
    draft.current = [];
    draftScene.current = null;
    setDrafted(0);
    setArranging(false);
    setPointedAt(null);
    setCantBecause(null);
  };
  /** Done: everything goes to the server together, and the room here comes back with it. */
  const save = async () => {
    const final = draftScene.current;
    if (savingRef.current) return;
    if (!final || draft.current.length === 0) {
      leaveRearranging();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setCantBecause(null);
    const took = await onMove(draft.current.map((d) => d.move));
    if (took) {
      const ids = new Set(draft.current.map((d) => d.move.object as string));
      const same = (a: Scene, b: Scene) =>
        [...ids].every((id) => {
          const pose = (s: Scene) => s.objects.find((o) => o.id === id)?.transform;
          return JSON.stringify(pose(a)) === JSON.stringify(pose(b));
        });
      for (let i = 0; i < ROOM_TAKES_MOVE_POLLS; i++) {
        if (same(placeRef.current.scene, final)) break;
        await new Promise((done) => setTimeout(done, 100));
      }
      leaveRearranging();
    }
    savingRef.current = false;
    setSaving(false);
  };

  return (
    <div className="stage">
      {!ready && <StillDrawing />}
      {canMove && !arranging && (
        <button
          type="button"
          className="sys-pill rearrange-open"
          onClick={() => {
            setThing(null);
            setPerson(null);
            setCantBecause(null);
            setPointedAt(null);
            setArranging(true);
          }}
        >
          <span aria-hidden>{"\u{1FA91}"}</span> Rearrange
        </button>
      )}
      {arranging && (
        <div className="move-bar" role="dialog" aria-label="Rearrange">
          <span className={cantBecause ? "move-hint t-bad" : "move-hint"}>
            {saving
              ? "Saving\u2026"
              : (cantBecause ??
                (pointedAt
                  ? nameOf(pointedAt)
                  : ownCopy
                    ? "Drag anything blue. This is your own copy: only you see it."
                    : "Drag anything blue to move it. Everyone here will see it."))}
          </span>
          <div className="move-buttons">
            {pointedAt && (
              <button
                type="button"
                className="mini move-icon"
                disabled={saving}
                aria-label="Turn it"
                title="Turn it"
                onClick={turn}
              >
                <Icon path="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z" />
              </button>
            )}
            <button
              type="button"
              className="mini move-icon"
              disabled={saving || drafted === 0}
              aria-label="Undo"
              title="Undo"
              onClick={undo}
            >
              <Icon path="M12.5 8c-2.6 0-5 1-6.9 2.6L2 7v9h9l-3.6-3.6A8 8 0 0 1 20.9 16l2.4-.8A10.5 10.5 0 0 0 12.5 8z" />
            </button>
            <button
              type="button"
              className="primary move-icon"
              disabled={saving}
              aria-label={drafted > 0 ? "Save" : "Done"}
              title={drafted > 0 ? "Save" : "Done"}
              onClick={() => void save()}
            >
              <Icon path="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" />
            </button>
          </div>
        </div>
      )}
      <canvas ref={canvas} className="stage-canvas" aria-label={place.spec.name} />
      <SpeedReadout renderer={renderer} />
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
                      // Practice takes time: what's free to try builds a skill, it doesn't
                      // promise one.
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
            {!canMove && canBeMoved(obj) && (
              <p className="muted small">Only whoever owns this place can move things here.</p>
            )}
            {canMove && canBeMoved(obj) && (
              <button
                type="button"
                className="menu-action"
                onClick={() => {
                  setThing(null);
                  setCantBecause(null);
                  setPointedAt(obj.id);
                  setArranging(true);
                }}
              >
                <span className="grow">Move this</span>
              </button>
            )}
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

/** A plain icon for a button: the shape is ours, and the button says what it does. */
function Icon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

/** `#speed` in the address shows how a real device is keeping up. Nobody sees it otherwise. */
function SpeedReadout({ renderer }: { renderer: MutableRefObject<Renderer | null> }) {
  const [text, setText] = useState("");
  const on = location.hash.includes("speed");
  useEffect(() => {
    if (!on) return;
    const every = setInterval(() => {
      const s = renderer.current?.speed();
      if (s) {
        const at = s.you ? ` · at ${s.you.xMm},${s.you.zMm}` : "";
        setText(
          `${s.fps} fps · level ${s.level} · ${s.drawCalls} draws · ${s.triangles} tris${at}`,
        );
      }
    }, 100);
    return () => clearInterval(every);
  }, [on, renderer]);
  return on ? <div className="speed-readout">{text}</div> : null;
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
