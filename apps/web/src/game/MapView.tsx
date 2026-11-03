/**
 * The city map screen: the model's city drawn by the engine, with a DOM pin (emoji and name)
 * on every place you can go, labels for districts and water, and a marker where you are.
 * Pins follow the camera every frame by writing transforms directly, without React renders.
 */
import { type CityMap, createCityMap } from "@aye/engine";
import {
  type CityPlace,
  type CitySpec,
  districtsOf,
  isOpen,
  type LandCover,
  placesOf,
  type RoadNetwork,
  waterOf,
} from "@aye/schema";
import { useEffect, useRef, useState } from "react";
import { StillDrawing } from "./StillDrawing.tsx";
import type { LifeFrame } from "./useCityLife.ts";

/** How far a finger may wobble and still be tapping, and how near a pin a tap counts as on it. */
const PIN_TAP_PX = 12;
const PIN_REACH_PX = 30;

export function MapView({
  city,
  places,
  here,
  built,
  minuteOfDay,
  selected,
  census,
  life,
  network,
  land,
  plan,
  onRoad,
  onGround,
  onSelect,
  onBackend,
}: {
  /** A real city's road network, once it has arrived. */
  network?: RoadNetwork | null;
  /** And what covers its ground (water, land use). */
  land?: LandCover | null;
  /** A planner's scenario to draw, or null. */
  plan?: Parameters<CityMap["setPlan"]>[0];
  /** While planning: a click picks the real road under it (its link), or null. */
  onRoad?: ((link: number | null) => void) | null;
  /** While choosing a spot: a click picks that point on the ground, metres. */
  onGround?: ((x: number, z: number) => void) | null;
  city: CitySpec;
  /** The places you can see (yours and the public ones). */
  places: readonly CityPlace[];
  here: string | null;
  built: ReadonlySet<string>;
  minuteOfDay: number;
  selected: string | null;
  /** Players at each place. */
  census: Readonly<Record<string, number>>;
  /** City life to draw each frame, or null to hide it. */
  life: (() => LifeFrame | null) | null;
  onSelect(key: string | null): void;
  onBackend(backend: string): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const map = useRef<CityMap | null>(null);
  const pins = useRef(new Map<string, HTMLElement>());
  const labels = useRef(new Map<string, HTMLElement>());
  const select = useRef(onSelect);
  select.current = onSelect;
  const lifeRef = useRef(life);
  lifeRef.current = life;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let frame = 0;
    void createCityMap(canvas.current as HTMLCanvasElement).then((m) => {
      if (disposed) return m.dispose();
      map.current = m;
      onBackend(m.backend);
      m.onSelect((key) => select.current(key));
      setReady(true);
      const tick = () => {
        m.setLife(lifeRef.current?.() ?? null);
        for (const [key, el] of pins.current) {
          const at = m.pinOf(key);
          el.style.display = at ? "" : "none";
          if (at) el.style.transform = `translate(${at.x}px, ${at.y}px)`;
        }
        for (const [key, el] of labels.current) {
          const [x, z] = key.split(",").map(Number) as [number, number];
          const at = m.screenOf(x, z, 4);
          el.style.display = at ? "" : "none";
          if (at) el.style.transform = `translate(${at.x}px, ${at.y}px)`;
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      map.current?.dispose();
      map.current = null;
    };
  }, [onBackend]);

  useEffect(() => {
    if (ready) map.current?.load(city, network ?? null, land ?? null);
  }, [city, ready, network, land]);

  // Open where you are, close enough to see the street, like a game rather than a chart.
  const flown = useRef(false);
  useEffect(() => {
    if (!ready || flown.current || !here) return;
    flown.current = true;
    map.current?.focus(here, { close: true });
  }, [ready, here]);

  useEffect(() => {
    if (ready) map.current?.setPlan(plan ?? null);
  }, [ready, plan, city, network]);

  // Without hover (a touchscreen), a pin is no hard edge for a finger: the map takes every
  // gesture, so one that starts on a pin still pans, and a tap here finds the pin it was for.
  useEffect(() => {
    const el = canvas.current;
    if (!el || !globalThis.matchMedia("(hover: none)").matches) return;
    let down: { x: number; y: number } | null = null;
    let fingers = 0;
    const onDown = (e: PointerEvent) => {
      fingers += 1;
      down = fingers > 1 ? null : { x: e.clientX, y: e.clientY };
    };
    const onCancel = () => {
      fingers = Math.max(0, fingers - 1);
      down = null;
    };
    const onUp = (e: PointerEvent) => {
      if (e.target !== el) return;
      fingers = Math.max(0, fingers - 1);
      const at = down;
      down = null;
      if (!at || Math.hypot(e.clientX - at.x, e.clientY - at.y) > PIN_TAP_PX) return;
      let best: { key: string; away: number } | null = null;
      for (const [key, pin] of pins.current) {
        if (pin.style.display === "none") continue;
        const r = pin.querySelector(".pin-icon")?.getBoundingClientRect();
        if (!r) continue;
        const away = Math.hypot(
          e.clientX - (r.left + r.width / 2),
          e.clientY - (r.top + r.height / 2),
        );
        if (away <= PIN_REACH_PX && (!best || away < best.away)) best = { key, away };
      }
      if (best) select.current(best.key);
    };
    el.addEventListener("pointerdown", onDown);
    // Heard after the map's own pick, whenever that was set up: the pin's word is the last.
    globalThis.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      globalThis.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
    };
  }, []);

  // Planning: a click (not a drag) on the map picks a road. Choosing a spot: it picks a point.
  useEffect(() => {
    const el = canvas.current;
    if (!el || (!onRoad && !onGround)) return;
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = e.isPrimary ? { x: e.clientX, y: e.clientY } : null;
    };
    const onUp = (e: PointerEvent) => {
      const reach = e.pointerType === "touch" ? PIN_TAP_PX : 5;
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > reach) return;
      down = null;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (onGround) {
        const at = map.current?.groundAt(x, y);
        if (at) onGround(at[0], at[1]);
        return;
      }
      onRoad?.(map.current?.roadAt(x, y, e.pointerType === "touch") ?? null);
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, [onRoad, onGround]);

  useEffect(() => {
    if (ready) map.current?.setTime(minuteOfDay);
  }, [ready, minuteOfDay]);

  useEffect(() => {
    map.current?.setSelected(selected);
    if (selected) map.current?.focus(selected);
  }, [selected]);

  const centroid = (poly: readonly (readonly [number, number])[]) => {
    const x = poly.reduce((s, p) => s + p[0], 0) / poly.length;
    const z = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    return `${Math.round(x)},${Math.round(z)}`;
  };
  const areaLabels = [
    // A district's name goes where its places are: its region can run out over the water.
    ...districtsOf(city).map((d) => {
      const own = placesOf(city).filter((p) => p.district === d.key);
      return {
        at: own.length > 0 ? centroid(own.map((p) => p.at)) : centroid(d.polygon),
        name: d.name,
        water: false,
      };
    }),
    ...waterOf(city).map((w) => ({ at: centroid(w.polygon), name: w.name, water: true })),
  ];

  return (
    <div className="stage">
      <canvas ref={canvas} className="stage-canvas" aria-label={`Map of ${city.name}`} />
      {city.real && (
        <a
          className="map-credit"
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer noopener"
        >
          Map data © OpenStreetMap contributors
        </a>
      )}
      {!ready && <StillDrawing />}
      {/* Until the map can place them, labels would all pile up in the corner. */}
      <div
        className="overlay"
        aria-hidden={false}
        style={ready ? undefined : { visibility: "hidden" }}
      >
        {areaLabels.map((l) => (
          <div
            key={`${l.at}-${l.name}`}
            className={`area-label ${l.water ? "water" : ""}`}
            ref={(el) => {
              if (el) labels.current.set(l.at, el);
              else labels.current.delete(l.at);
            }}
          >
            {l.name}
          </div>
        ))}
        {places.map((p) => {
          const open = isOpen(p.hours, minuteOfDay);
          const ok = built.has(p.key);
          return (
            <button
              key={p.key}
              type="button"
              className={`pin ${selected === p.key ? "selected" : ""} ${here === p.key ? "here" : ""} ${!ok || !open ? "dim" : ""}`}
              ref={(el) => {
                if (el) pins.current.set(p.key, el);
                else pins.current.delete(p.key);
              }}
              onClick={() => onSelect(p.key)}
              aria-label={`${p.name}${here === p.key ? " (you are here)" : ""}`}
            >
              <span className="pin-icon" aria-hidden>
                {ok ? p.icon : "\u{1F6A7}"}
              </span>
              <span className="pin-name">{p.name}</span>
              {(census[p.key] ?? 0) > 0 && (
                <span className="pin-count" title="Players here">
                  {census[p.key]}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
