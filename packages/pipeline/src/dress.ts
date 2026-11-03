/**
 * Dressing: after a city or a place works, make everything in it look like what it is. Every
 * look the models wrote (buildings, scenery and character looks in a city; things and people
 * in a place) goes through the visual loop (refineLooks): judged on contact sheets, redesigned
 * where weak from a picture of itself and the critic's notes, judged again. The improved looks
 * are compiled back under the same bounds as the first ones, so dressing can't break a spec.
 */
import {
  type CitySpec,
  CitySpec as CitySpecSchema,
  mapBlock,
  placesOf,
  type Scene,
  type StageRecord,
  type WorldSpec,
  WorldSpec as WorldSpecSchema,
} from "@aye/schema";
import {
  type DraftPersonShape,
  type DraftSolid,
  PersonRedesign,
  SolidsRedesign,
  ThingRedesign,
} from "./contracts.ts";
import { draftSolid, solidsOf } from "./draft-values.ts";
import {
  buildingTile,
  type LookSubject,
  lookTile,
  personTile,
  type RefineDeps,
  refineLooks,
  thingTile,
} from "./looks.ts";
import {
  compileKind,
  compilePersonLook,
  draftOfKind,
  draftOfPersonLook,
  type WorldCritique,
} from "./world.ts";

export interface DressResult<S> {
  spec: S;
  findings: WorldCritique[];
  stages: StageRecord[];
  cached: number;
  /** Final score of each look, by label. */
  scores: Map<string, number>;
}

type Solids = { shapes: DraftSolid[] };
type Figure = { heightMm: number; shapes: DraftPersonShape[] };

const solidsFrame = (what: string, [w, h, d]: [number, number, number]) =>
  `${what} fills a box ${w.toFixed(1)} m wide (x), ${h.toFixed(1)} m tall (y) and ${d.toFixed(1)} m deep (z). Coordinates are relative to that box: x and z from -500 to 500 across its width and depth (0 is the centre, +z is its front), y from 0 (the ground) to 1000 (the top of the box; up to 2000 for anything above it), sizes w, h, d in thousandths of the box, colours #rrggbb.`;

/** A travel mode's look: like any solids, but its front faces +x (the way it goes). */
const vehicleFrame = (what: string, [l, h, w]: [number, number, number]) =>
  `${what} fills a box ${l.toFixed(1)} m long (x), ${h.toFixed(1)} m tall (y) and ${w.toFixed(1)} m wide (z), its front facing +x, the way it travels. Coordinates are relative to that box: x from -500 (back) to 500 (front), z from -500 to 500 across it, y from 0 (the ground) to 1000 (its top), sizes w, h, d in thousandths of its length, height and width, colours #rrggbb.`;

const FIGURE_FRAME =
  "A person standing, facing +z, in millimetres from their feet: x to their right, y up, z forward; heightMm is their height. Every shape is tagged with the part it moves with: body (torso, neck, hips, anything hanging from the waist), head (head, face, hair, headwear), arm_left and arm_right (shoulder to hand; they swing from the shoulder), leg_left and leg_right (hip to shoe; they swing from the hip). Colours are #rrggbb or the slots skin, top, bottom, hair, accent, filled from the person's colours.";

function solidsSubject(
  id: string,
  label: string,
  role: string,
  frame: string,
  draft: Solids,
  draw: (d: Solids) => ReturnType<typeof buildingTile>,
): LookSubject<Solids> {
  return {
    id,
    label,
    role,
    frame,
    draft,
    parse: (raw) => {
      const r = SolidsRedesign.safeParse(raw);
      return r.success && r.data.shapes.length > 0 ? r.data : null;
    },
    tile: draw,
  };
}

function figureSubject(
  id: string,
  label: string,
  role: string,
  draft: Figure,
  colours: Parameters<typeof personTile>[1],
): LookSubject<Figure> {
  return {
    id,
    label,
    role,
    frame: FIGURE_FRAME,
    draft,
    parse: (raw) => {
      const r = PersonRedesign.safeParse(raw);
      return r.success && r.data.shapes.length > 0 ? r.data : null;
    },
    tile: (d) => {
      const look = compilePersonLook(d.shapes, d.heightMm, [], label);
      return look ? personTile(look, colours) : { shapes: [] };
    },
  };
}

/** Refine every building, kind seen on the map, and character look in a city. */
export async function dressCity(city: CitySpec, deps: RefineDeps): Promise<DressResult<CitySpec>> {
  const colours = {
    skin: city.looks.skin[1] ?? city.looks.skin[0] ?? "#8d5524",
    top: city.looks.outfit[0] ?? "#1a7f4e",
    bottom: city.looks.outfit[1] ?? "#2c3e50",
    hair: city.looks.hair[0] ?? "#1a1310",
    accent: city.looks.outfit[2] ?? "#f2e6c9",
  };
  const places = placesOf(city);
  const solids: LookSubject<Solids>[] = [
    // Each place's own building, in its map block.
    ...places.map((p) =>
      solidsSubject(
        `place:${p.key}`,
        `${p.name}: ${p.blurb}`,
        `a building on the map of ${city.name}, seen from above`,
        solidsFrame("The building", mapBlock(p)),
        { shapes: (p.look?.solids ?? []).map(draftSolid) },
        (d) =>
          buildingTile({
            ...p,
            look: { sizeM: [1, 1, 1], solids: solidsOf(d.shapes, 32, [], p.name) },
          }),
      ),
    ),
    // Every other kind seen on the map as itself (what people travel in, what stands
    // around), in its own box.
    ...city.kinds.flatMap((k) => {
      const look = k.look;
      if (!look || look.asset || k.traits.place) return [];
      const mover = k.traits.mover !== undefined;
      return [
        solidsSubject(
          `kind:${k.key}`,
          `${k.name}: ${k.about}`,
          mover
            ? `how people travelling by ${k.name} look on the map of ${city.name}, seen from above; front facing +x`
            : `something standing on the map of ${city.name}`,
          mover ? vehicleFrame(k.name, look.sizeM) : solidsFrame(k.name, look.sizeM),
          { shapes: look.solids.map(draftSolid) },
          (d) => lookTile({ sizeM: look.sizeM, solids: solidsOf(d.shapes, 32, [], k.name) }),
        ),
      ];
    }),
  ];
  const figures = city.characters.map((c, i) =>
    figureSubject(
      `character:${i}`,
      `Character look ${i + 1}, a person in ${city.name}`,
      "a person new players can look like (their colours are filled in per player)",
      { heightMm: c.heightMm, shapes: draftOfPersonLook(c) },
      colours,
    ),
  );
  const [a, b] = await Promise.all([refineLooks(solids, deps), refineLooks(figures, deps)]);
  const dressed = CitySpecSchema.parse({
    ...city,
    kinds: city.kinds.map((k) => {
      const d = a.drafts.get(`kind:${k.key}`);
      const solids = d ? solidsOf(d.shapes, 32, [], k.name) : [];
      return d && k.look && solids.length > 0 ? { ...k, look: { ...k.look, solids } } : k;
    }),
    items: city.items.map((i) => {
      const d = a.drafts.get(`place:${i.key}`);
      const place = places.find((p) => p.key === i.key);
      const solids = d ? solidsOf(d.shapes, 32, [], i.name) : [];
      if (!d || !place || solids.length === 0) return i;
      return { ...i, look: { sizeM: place.look?.sizeM ?? [1, 1, 1], solids } };
    }),
    characters: city.characters.map((c, i) => {
      const d = b.drafts.get(`character:${i}`);
      return (d && compilePersonLook(d.shapes, d.heightMm, [], "character")) || c;
    }),
  });
  return {
    spec: dressed,
    findings: [...a.findings, ...b.findings],
    stages: [...a.stages, ...b.stages],
    cached: a.cached + b.cached,
    scores: new Map([
      ...solids.map((s) => [s.label, a.scores.get(s.id) ?? 0] as const),
      ...figures.map((s) => [s.label, b.scores.get(s.id) ?? 0] as const),
    ]),
  };
}

/** Refine every kind of thing (at the size of a thing of that kind) and every person in a place. */
export async function dressWorld(
  spec: WorldSpec,
  scene: Scene,
  deps: RefineDeps & {
    /** Dress only these kinds and nobody else: what changed, when the rest is already dressed. */
    onlyKinds?: readonly string[];
  },
): Promise<DressResult<WorldSpec>> {
  const only = deps.onlyKinds ? new Set(deps.onlyKinds) : null;
  const sizeOf = new Map<string, { w: number; h: number; d: number }>();
  for (const t of spec.things) {
    if (sizeOf.has(t.kind)) continue;
    const o = scene.objects.find((x) => x.id === t.object);
    if (o) sizeOf.set(t.kind, o.size);
  }
  type ThingDraft = { shapes: ReturnType<typeof draftOfKind>["look"] };
  const toDress = only ? spec.kinds.filter((k) => only.has(k.key)) : spec.kinds;
  const things: LookSubject<ThingDraft>[] = toDress.map((k) => {
    const size = sizeOf.get(k.key) ?? { w: 1000, h: 1000, d: 1000 };
    const base = draftOfKind(k);
    const kindOf = (d: ThingDraft) => compileKind({ ...base, look: d.shapes }, []);
    return {
      id: `kind:${k.key}`,
      label: k.label,
      role: `a thing in ${spec.name}`,
      frame: `${solidsFrame(k.label, [size.w / 1000, size.h / 1000, size.d / 1000])} Shapes with "when" conditions on the thing's state show only in that state (vars: ${k.vars.map((v) => `${v.key} 0..${v.max}, starts ${v.initial}`).join("; ") || "none"}); the picture shows its starting state.`,
      draft: { shapes: base.look },
      parse: (raw) => {
        const r = ThingRedesign.safeParse(raw);
        return r.success && r.data.shapes.length > 0 ? r.data : null;
      },
      tile: (d) => thingTile(kindOf(d), size),
    };
  });
  const figures = (only ? [] : spec.people).flatMap((p) =>
    p.look
      ? [
          figureSubject(
            `person:${p.key}`,
            `${p.name}, ${p.about}`,
            `a person in ${spec.name}`,
            { heightMm: p.look.heightMm, shapes: draftOfPersonLook(p.look) },
            p.colours,
          ),
        ]
      : [],
  );
  const [a, b] = await Promise.all([refineLooks(things, deps), refineLooks(figures, deps)]);
  const dressed = WorldSpecSchema.parse({
    ...spec,
    kinds: spec.kinds.map((k) => {
      const d = a.drafts.get(`kind:${k.key}`);
      if (!d) return k;
      const next = compileKind({ ...draftOfKind(k), look: d.shapes }, []);
      // Only the look changes: rules stay exactly as written and play-tested.
      return { ...k, look: next.look };
    }),
    people: spec.people.map((p) => {
      const d = b.drafts.get(`person:${p.key}`);
      const look = d && compilePersonLook(d.shapes, d.heightMm, [], p.name);
      return look ? { ...p, look } : p;
    }),
  });
  return {
    spec: dressed,
    findings: [...a.findings, ...b.findings],
    stages: [...a.stages, ...b.stages],
    cached: a.cached + b.cached,
    scores: new Map([
      ...things.map((s) => [s.label, a.scores.get(s.id) ?? 0] as const),
      ...figures.map((s) => [s.label, b.scores.get(s.id) ?? 0] as const),
    ]),
  };
}
