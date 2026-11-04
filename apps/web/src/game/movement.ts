/**
 * Steering: WASD, the arrow keys or an on-screen stick move whoever you're playing, relative
 * to where the camera looks. Your own device walks them at once (see the engine's `steer.ts`);
 * what the server hears is still only intents: every few hundred milliseconds while you steer, a
 * `walk` to a point a little ahead of them, which it checks like any other (reachable, theirs to
 * command, rate-limited); letting go walks them to where they stand, which stops them.
 */
import { aimAhead, type Footing, type Renderer } from "@aye/engine";
import { useEffect, useRef } from "react";

/** How far ahead each step aims, in millimetres, and how often a step is sent. */
const AHEAD_MM = 1_800;
const EVERY_MS = 220;
/** How often keys and the stick are read: a press should show within a frame or two. */
const READ_MS = 16;

const KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

export interface Steering {
  /** The stick's push: x right, y forward, each -1..1. */
  setStick(x: number, y: number): void;
}

export function useSteering(
  renderer: Renderer | null,
  slot: number | null,
  walk: (xMm: number, zMm: number) => void,
  onSteer: () => void,
  /** How fast they walk just now, in millimetres a second. */
  speedMmPerS: () => number,
  footing: Footing,
): Steering {
  const held = useRef(new Set<string>());
  const stick = useRef<[number, number]>([0, 0]);
  const moving = useRef(false);
  const live = useRef({ renderer, slot, walk, onSteer, speedMmPerS, footing });
  live.current = { renderer, slot, walk, onSteer, speedMmPerS, footing };

  useEffect(() => {
    const typing = (e: KeyboardEvent) =>
      e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    const down = (e: KeyboardEvent) => {
      if (!KEYS[e.code] || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      held.current.add(e.code);
    };
    const up = (e: KeyboardEvent) => held.current.delete(e.code);
    const blur = () => held.current.clear();
    globalThis.addEventListener("keydown", down);
    globalThis.addEventListener("keyup", up);
    globalThis.addEventListener("blur", blur);

    let sentAt = 0;
    const tick = setInterval(() => {
      const {
        renderer: r,
        slot: s,
        walk: go,
        onSteer: steer,
        speedMmPerS: pace,
        footing: fits,
      } = live.current;
      if (!r || s === null) return;
      let [x, y] = stick.current;
      for (const code of held.current) {
        const k = KEYS[code];
        if (k) {
          x += k[0];
          y += k[1];
        }
      }
      const length = Math.hypot(x, y);
      const at = r.whereIs(s);
      if (!at) return;
      if (length < 0.2) {
        if (moving.current) {
          moving.current = false;
          r.steer(s, null);
          go(at.x, at.z);
        }
        return;
      }
      // Forward is where the camera looks; right is forward turned a quarter clockwise.
      const f = r.facing();
      const dx = (f.x * y - f.z * x) / Math.max(1, length);
      const dz = (f.z * y + f.x * x) / Math.max(1, length);
      const size = Math.hypot(dx, dz) || 1;
      r.steer(s, { dx: dx / size, dz: dz / size, speedMmPerS: pace() * Math.min(1, length) });
      const now = performance.now();
      const started = !moving.current;
      moving.current = true;
      if (!started && now - sentAt < EVERY_MS) return;
      sentAt = now;
      steer();
      const [ax, az] = aimAhead(at.x, at.z, dx / size, dz / size, AHEAD_MM, fits);
      go(Math.round(ax), Math.round(az));
    }, READ_MS);
    return () => {
      clearInterval(tick);
      globalThis.removeEventListener("keydown", down);
      globalThis.removeEventListener("keyup", up);
      globalThis.removeEventListener("blur", blur);
    };
  }, []);

  return {
    setStick(x, y) {
      stick.current = [x, y];
    },
  };
}
