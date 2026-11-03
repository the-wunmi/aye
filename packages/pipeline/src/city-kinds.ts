/**
 * Compiling a city's kinds and items: the model declares the kinds of things its
 * city is made of (with the traits each has) and places items of them; code derives every key
 * from names, resolves kinds and districts by name, clamps every number to `KIND_BOUNDS` and
 * the map, checks colours and icons, and says in words what it had to change. Nothing here
 * knows what any kind is.
 */
import {
  type Attrs,
  type Item,
  KIND_BOUNDS,
  type Kind,
  type Look,
  type PlaceTrait,
  type Traits,
} from "@aye/schema";
import { cleanText } from "./assemble.ts";
import type { DraftCityItem as DraftItem, DraftCityKind as DraftKind } from "./contracts.ts";
import { clamp, colour, draftSolid, icon, PIN, solidsOf } from "./draft-values.ts";
import { keyOf } from "./world.ts";

const B = KIND_BOUNDS;
type DraftLook = DraftKind["look"];
type DraftPlace = NonNullable<DraftKind["place"]>;

export function lookOf(d: DraftLook, issues: string[], where: string): Look | null {
  if (!d) return null;
  const solids = solidsOf(d.shapes, B.shapes, issues, where);
  if (solids.length === 0) {
    issues.push(`${where} has an empty look: give it shapes, or no look at all.`);
    return null;
  }
  return {
    sizeM: [
      clamp(d.lengthM, 1, B.sizeM),
      clamp(d.heightM, 1, B.sizeM),
      clamp(d.widthM, 1, B.sizeM),
    ],
    solids,
  };
}

const hoursOf = (from: number, to: number) =>
  from < 0 || to < 0 ? null : { from: clamp(from, 0, 1439), to: clamp(to, 0, 1439) };

function placeOf(d: DraftPlace): PlaceTrait {
  return {
    hours: hoursOf(d.opens, d.closes),
    private: d.private,
    tags: [...new Set(d.tags.map((t) => keyOf(t)).filter((t) => t !== ""))].slice(0, B.tags),
    footprintM: [clamp(d.widthM, 6, B.sizeM), clamp(d.depthM, 6, B.sizeM)],
    heightM: clamp(d.heightM, 2, B.heightM),
    build: cleanText(d.inside, 600),
    ...(d.needsMark.trim() && !d.private
      ? { asks: [{ mark: keyOf(d.needsMark), atLeast: clamp(d.needsAtLeast, 1, 1_000) }] }
      : {}),
  };
}

function attrsOf(list: DraftKind["attrs"]): Attrs {
  const out: Attrs = {};
  for (const a of list.slice(0, B.attrs)) {
    const k = keyOf(a.name);
    if (a.name.trim() && !(k in out)) out[k] = cleanText(a.value, B.attrText);
  }
  return out;
}

/** The kinds and items of a city, bounded, on a map `mapM` metres across. */
export function compileKinds(
  draft: { kinds: readonly DraftKind[]; items: readonly DraftItem[] },
  issues: string[],
  mapM: number,
): { kinds: Kind[]; items: Item[] } {
  const point = ([x, z]: readonly [number, number]): [number, number] => [
    clamp(x, 0, mapM),
    clamp(z, 0, mapM),
  ];
  const kinds: Kind[] = [];
  const kindByName = new Map<string, string>();
  for (const d of draft.kinds.slice(0, B.kinds)) {
    const key = keyOf(d.name);
    const where = `kind "${cleanText(d.name, 40)}"`;
    if (!d.name.trim() || kindByName.has(key)) {
      issues.push(`${where} has the same name as another (or none); kept the first.`);
      continue;
    }
    const traits: Traits = {};
    if (d.place) traits.place = placeOf(d.place);
    if (d.mover) {
      const m = d.mover;
      traits.mover = {
        way: m.way,
        speedKmh: clamp(m.speedKmh, B.speedKmh.min, B.speedKmh.max),
        holds: clamp(m.holds, 0, B.holds),
        fare: { base: clamp(m.baseFare, 0, B.fare), perKm: clamp(m.farePerKm, 0, B.fare) },
        hours: hoursOf(m.from, m.to),
        reach: m.reach.trim() ? keyOf(m.reach) : null,
        serves: [...new Set(m.serves.map((name) => keyOf(name)))],
        tires: m.tires.map((t) => ({
          need: keyOf(t.need),
          perHour: clamp(t.perHour, 1, 1_000),
        })),
      };
    }
    if (d.area) traits.area = { blocks: d.area.blocks, fill: [] };
    if (d.line) traits.line = { widthM: clamp(d.line.widthM, B.widthM.min, B.widthM.max) };
    if (d.prop) traits.prop = {};
    const look = lookOf(d.look, issues, where);
    if ((traits.mover || traits.prop) && !look) {
      issues.push(`${where} is seen on the map but has no look: draw it.`);
    }
    kindByName.set(key, key);
    kinds.push({
      key,
      name: cleanText(d.name, 80) || "Thing",
      about: cleanText(d.about, 200),
      icon: icon(d.icon, PIN, issues, where),
      colour: colour(d.colour, "#b0a898", issues, where),
      look,
      traits,
      attrs: attrsOf(d.attrs),
    });
  }
  for (const k of kinds) {
    const reach = k.traits.mover?.reach;
    if (reach && !kindByName.has(reach)) {
      issues.push(`kind "${k.name}" is reached by "${reach}", which isn't a kind; on foot.`);
      if (k.traits.mover) k.traits.mover.reach = null;
    }
  }
  const kindOf = new Map(kinds.map((k) => [k.key, k]));

  const items: Item[] = [];
  const seen = new Set<string>();
  for (const d of draft.items.slice(0, B.items)) {
    const key = keyOf(d.name);
    const where = `item "${cleanText(d.name, 40)}"`;
    const kind = kindOf.get(keyOf(d.kind));
    if (!kind) {
      issues.push(`${where} is of kind "${cleanText(d.kind, 40)}", which isn't a kind; dropped.`);
      continue;
    }
    if (!d.name.trim() || seen.has(key)) {
      issues.push(`${where} has the same name as another (or none); kept the first.`);
      continue;
    }
    seen.add(key);
    const look = lookOf(d.look, issues, where);
    items.push({
      key,
      kind: kind.key,
      name: cleanText(d.name, 80) || kind.name,
      blurb: cleanText(d.blurb, 200),
      ...(d.icon.trim() ? { icon: icon(d.icon, kind.icon, issues, where) } : {}),
      ...(d.colour.trim() ? { colour: colour(d.colour, kind.colour, issues, where) } : {}),
      ...(look ? { look } : {}),
      traits: d.place && kind.traits.place ? { place: placeOf(d.place) } : {},
      where: {
        district: d.district.trim() ? keyOf(d.district) : null,
        at: d.x < 0 || d.z < 0 ? null : point([d.x, d.z]),
        spots: d.spots.slice(0, B.spots).map(point),
        polygon: d.polygon.slice(0, B.polygon).map(point),
        line: d.line.slice(0, B.linePoints).map(point),
      },
      attrs: attrsOf(d.attrs),
    });
  }
  // Districts are named by the model; an unknown one is said, and the place keeps none.
  const districts = new Set(
    items.filter((i) => kindOf.get(i.kind)?.traits.area?.blocks === false).map((i) => i.key),
  );
  for (const item of items) {
    const d = item.where.district;
    if (d && !districts.has(d)) {
      issues.push(`item "${item.name}" is in district "${d}", which isn't an area of land.`);
      item.where.district = null;
    }
  }
  // Where each way around goes: places the city has; a place it invented doesn't count.
  const placeKeys = new Set(items.filter((i) => i.where.at).map((i) => i.key));
  for (const k of kinds) {
    const m = k.traits.mover;
    if (!m) continue;
    const known = m.serves.filter((key) => placeKeys.has(key));
    if (known.length < m.serves.length) {
      issues.push(
        `kind "${k.name}" goes to ${m.serves.length - known.length} place(s) that aren't in this city.`,
      );
    }
    m.serves = known;
  }
  return { kinds, items };
}

const lookDraft = (l: Look | null | undefined): DraftLook =>
  l
    ? {
        lengthM: l.sizeM[0],
        heightM: l.sizeM[1],
        widthM: l.sizeM[2],
        shapes: l.solids.map(draftSolid),
      }
    : null;

const placeDraft = (p: PlaceTrait): DraftPlace => ({
  needsMark: p.asks?.[0]?.mark ?? "",
  needsAtLeast: p.asks?.[0]?.atLeast ?? 0,
  opens: p.hours?.from ?? -1,
  closes: p.hours?.to ?? -1,
  private: p.private,
  tags: p.tags,
  widthM: p.footprintM[0],
  depthM: p.footprintM[1],
  heightM: p.heightM,
  inside: p.build,
});

const attrsDraft = (a: Attrs) =>
  Object.entries(a).map(([name, value]) => ({ name, value: String(value) }));

/** The model-facing form of a city's kinds and items, for revising them. */
export function draftOfKinds(city: { kinds: readonly Kind[]; items: readonly Item[] }): {
  kinds: DraftKind[];
  items: DraftItem[];
} {
  const kindName = new Map(city.kinds.map((k) => [k.key, k.name]));
  const itemName = new Map(city.items.map((i) => [i.key, i.name]));
  return {
    kinds: city.kinds.map((k) => ({
      name: k.name,
      about: k.about,
      icon: k.icon,
      colour: k.colour,
      look: lookDraft(k.look),
      place: k.traits.place ? placeDraft(k.traits.place) : null,
      mover: k.traits.mover
        ? {
            way: k.traits.mover.way,
            speedKmh: k.traits.mover.speedKmh,
            holds: k.traits.mover.holds,
            baseFare: k.traits.mover.fare.base,
            farePerKm: k.traits.mover.fare.perKm,
            from: k.traits.mover.hours?.from ?? -1,
            to: k.traits.mover.hours?.to ?? -1,
            reach: k.traits.mover.reach ? (kindName.get(k.traits.mover.reach) ?? "") : "",
            serves: k.traits.mover.serves.flatMap((key) => itemName.get(key) ?? []),
            tires: k.traits.mover.tires,
          }
        : null,
      area: k.traits.area ? { blocks: k.traits.area.blocks } : null,
      line: k.traits.line ? { widthM: k.traits.line.widthM } : null,
      prop: k.traits.prop !== undefined,
      attrs: attrsDraft(k.attrs),
    })),
    items: city.items.map((i) => {
      const place = i.traits.place;
      const base = city.kinds.find((k) => k.key === i.kind)?.traits.place;
      return {
        name: i.name,
        kind: kindName.get(i.kind) ?? i.kind,
        blurb: i.blurb,
        icon: i.icon ?? "",
        colour: i.colour ?? "",
        district: i.where.district ? (itemName.get(i.where.district) ?? "") : "",
        x: i.where.at?.[0] ?? -1,
        z: i.where.at?.[1] ?? -1,
        spots: i.where.spots,
        polygon: i.where.polygon,
        line: i.where.line,
        look: lookDraft(i.look),
        place: place && base ? placeDraft({ ...base, ...place } as PlaceTrait) : null,
        attrs: attrsDraft(i.attrs),
      };
    }),
  };
}
