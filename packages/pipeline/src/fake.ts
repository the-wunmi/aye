/**
 * Deterministic fake providers for tests only. Nothing at runtime uses them: Muse is required.
 *
 * `fakeCapture(script)` replays a scripted SceneUnderstanding for a recording and records
 * every call, so tests can assert exactly when models were and were not invoked.
 * `fakeDescriber` does the same for descriptions. `fakeWorldAuthor` writes a plain but valid
 * world from any brief: one kind per distinct thing, each with one use, and two people. Its
 * worlds are deliberately simple; the point is that the whole harness runs without a model.
 * Scripts may contain adversarial content on purpose (prompt-injection labels, a person
 * described as furniture) to prove the pipeline contains it.
 */
import { encodeJson } from "@aye/artifacts";
import type { ArtifactRef, CitySpec, ModelRef, Scene } from "@aye/schema";
import { sampleCity, sampleLook } from "@aye/schema/fixtures";
import { draftOfCity } from "./city.ts";
import type {
  CityBrief,
  CityDraft,
  DraftKind,
  FrameSet,
  SceneUnderstanding,
  Track,
  TrackSet,
  WorldBrief,
  WorldDraft,
} from "./contracts.ts";
import type {
  CaptureProviders,
  CityAuthor,
  Describer,
  ImproviseRequest,
  LookCritic,
  LookDesigner,
  LookDesignRequest,
  LookItem,
  ProviderContext,
  WorldAuthor,
} from "./providers.ts";
import { draftOfPersonLook, keyOf } from "./world.ts";

const model = (name: string): ModelRef => ({ provider: "fake", model: name, version: "1" });

export interface FakeScript {
  understanding: SceneUnderstanding;
  /** The tracks the segmenter reports, e.g. a passer-by. */
  extraTracks?: Omit<Track, "masks">[];
}

export interface FakeCalls {
  sample: number;
  track: number;
  redact: number;
  understand: number;
  describe: number;
  author: number;
  revise: number;
  improvise: number;
}

export function fakeCalls(): FakeCalls {
  return {
    sample: 0,
    track: 0,
    redact: 0,
    understand: 0,
    describe: 0,
    author: 0,
    revise: 0,
    improvise: 0,
  };
}

export function fakeCapture(
  script: FakeScript,
  calls: FakeCalls = fakeCalls(),
): CaptureProviders & { calls: FakeCalls } {
  const putJson = (ctx: ProviderContext, value: unknown) =>
    ctx.store.put(encodeJson(value), "application/json");
  return {
    calls,
    sampler: {
      model: model("sampler"),
      async sample(video: ArtifactRef, ctx) {
        calls.sample++;
        const frames = [];
        for (let i = 0; i < 4; i++) {
          frames.push({
            index: i * 30,
            timeMs: i * 1000,
            image: await putJson(ctx, { video: video.hash, frame: i }),
          });
        }
        return { frames, widthPx: 1920, heightPx: 1080 };
      },
    },
    segmenter: {
      model: model("segmenter"),
      async track(_frames: FrameSet, ctx): Promise<TrackSet> {
        calls.track++;
        const masks = await putJson(ctx, { masks: "fake" });
        return { tracks: (script.extraTracks ?? []).map((t) => ({ ...t, masks })) };
      },
    },
    redactor: {
      model: model("redactor"),
      async redact(frames, tracks, ctx) {
        calls.redact++;
        const hidden = tracks.tracks.filter((t) => t.private).map((t) => t.trackId);
        const out = [];
        for (const f of frames.frames) {
          out.push({ ...f, image: await putJson(ctx, { redacted: f.image.hash, hidden }) });
        }
        return { ...frames, frames: out };
      },
    },
    understander: {
      model: model("understander"),
      prompt: "Describe the place as SceneUnderstanding JSON.",
      async understand() {
        calls.understand++;
        return structuredClone(script.understanding);
      },
    },
  };
}

export function fakeDescriber(
  understanding: SceneUnderstanding,
  calls: FakeCalls = fakeCalls(),
): Describer {
  return {
    model: model("describer"),
    prompt: "Lay out the described place as SceneUnderstanding JSON.",
    async describe() {
      calls.describe++;
      return structuredClone(understanding);
    },
  };
}

/** A small stable colour from a name, so fake worlds look varied but never change. */
function colourFor(name: string): string {
  let h = 0x811c9dc5;
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  const v = (h >>> 0) & 0x7f7f7f;
  return `#${(v + 0x404040).toString(16).padStart(6, "0")}`;
}

/** One plain kind for a thing: a box, and one way to use it. */
function fakeKind(label: string): DraftKind {
  return {
    key: keyOf(label),
    label: label.slice(0, 80) || "Thing",
    travelKmh: 0,
    solid: true,
    note: "Offline stand-in.",
    vars: [],
    actions: [
      {
        key: "use",
        label: `Use the ${label.toLowerCase()}`.slice(0, 80),
        durationMin: 20,
        capacity: 2,
        cost: 0,
        income: 0,
        requires: [],
        marks: [],
        asks: [],
        outcomes: [],
        needs: [
          { need: "comfort", perHour: 300 },
          { need: "fun", perHour: 200 },
        ],
        sets: [],
        leaves: "no",
        pose: "stand",
        on: false,
      },
    ],
    supplies: [],
    look: [
      {
        shape: "box",
        x: 0,
        y: 500,
        z: 0,
        w: 1000,
        h: 1000,
        d: 1000,
        rx: 0,
        ry: 0,
        rz: 0,
        colour: colourFor(label),
        glow: false,
        when: [],
      },
    ],
  };
}

/** A plain world for any brief: deterministic, valid, and model-free. */
export function draftFromBrief(brief: WorldBrief): WorldDraft {
  const kinds = new Map<string, DraftKind>();
  for (const o of brief.objects) {
    const kind = fakeKind(o.label);
    if (!kinds.has(kind.key)) kinds.set(kind.key, kind);
  }
  const person = (key: string, name: string, seated: boolean) => ({
    key,
    name,
    about: "An offline stand-in.",
    skin: "#6b4430",
    top: seated ? "#c2562a" : "#2f4b7c",
    bottom: "#2f3a2f",
    hair: "#1a1310",
    accent: "#f2e6c9",
    heightMm: 1720,
    look: draftOfPersonLook(sampleLook(0)),
    widthMm: seated ? 800 : 600,
    stepMm: seated ? 20 : 220,
    stairs: !seated,
    slopePermille: seated ? 83 : 250,
    speedMmPerS: seated ? 1000 : 1300,
    seated,
    money: 1_000_000,
    needs: [],
  });
  return {
    name: brief.name || "A place",
    summary: brief.summary,
    hourPay: brief.hourPay || 100_000,
    livedIn: false,
    needs: [
      { key: "comfort", label: "Comfort", decayPerHour: 40 },
      { key: "fun", label: "Fun", decayPerHour: 50 },
    ],
    resources: [],
    kinds: [...kinds.values()],
    things: brief.objects.map((o) => ({
      object: o.index,
      kind: keyOf(o.label),
      state: [],
      owner: "",
    })),
    people: [person("ade", "Ade", false), person("bisi", "Bisi", false)],
    ground: brief.spaces.map((s) => ({
      space: s.index,
      colour: s.outdoor ? "#a9a59c" : "#e4ddd0",
    })),
    wallColour: "#f1ece2",
  };
}

export function fakeWorldAuthor(
  calls: FakeCalls = fakeCalls(),
): WorldAuthor & { calls: FakeCalls } {
  return {
    calls,
    model: model("world-author"),
    prompt: "Write the world as WorldDraft JSON.",
    revisePrompt: "Fix the findings.",
    improvisePrompt: "Extend the kind for the request.",
    effort: "none",
    async author(brief: WorldBrief) {
      calls.author++;
      return draftFromBrief(brief);
    },
    // Offline, there is nothing to learn: the same answer again.
    async revise(_brief: WorldBrief, previous: WorldDraft) {
      calls.revise++;
      return structuredClone(previous);
    },
    // Adds one action named after the request, so improvising is exercised end to end.
    async improvise(_brief: WorldBrief, request: ImproviseRequest) {
      calls.improvise++;
      const kind = structuredClone(request.kind);
      kind.actions.push({
        key: keyOf(request.request),
        label: request.request.slice(0, 80),
        durationMin: 10,
        capacity: 1,
        cost: 0,
        income: 0,
        requires: [],
        marks: [],
        asks: [],
        outcomes: [],
        needs: request.needs.slice(0, 1).map((need) => ({ need, perHour: 300 })),
        sets: [],
        leaves: "no",
        pose: "stand",
        on: false,
      });
      return kind;
    },
  };
}

/** XML-escape untrusted text. Labels come from a model reading a video: treat as hostile. */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Inverse of assembly, for tests: describe an existing Scene the way a model would. */
export function understandingFromScene(scene: Scene): SceneUnderstanding {
  const m = (mm: number) => mm / 1000;
  const key = (id: string) => id.replace(/^[a-z]+_/, "").slice(0, 32);
  return {
    place: { name: "Scripted place", summary: "Scripted scene", currency: "NGN" },
    spaces: scene.spaces.map((s) => ({
      key: key(s.id),
      name: s.name,
      polygon: s.polygon.map(([x, z]) => [m(x), m(z)] as [number, number]),
      floorOffsetM: m(s.floorOffsetMm),
      outdoor: s.ceilingMm === null,
    })),
    walls: scene.walls.map((w) => ({
      a: [m(w.a[0]), m(w.a[1])],
      b: [m(w.b[0]), m(w.b[1])],
      heightM: m(w.heightMm),
    })),
    openings: scene.openings.map((o) => ({
      key: key(o.id),
      kind: o.kind,
      at: [m(o.at[0]), m(o.at[1])],
      alongDeg: o.yawDeg,
      clearWidthM: m(o.clearWidthMm),
      thresholdM: m(o.thresholdMm),
      between: o.connects.map((s) => (s === null ? null : key(s))) as [
        string | null,
        string | null,
      ],
    })),
    levelChanges: scene.levelChanges.map((c) => ({
      key: key(c.id),
      kind: c.kind,
      from: [m(c.from[0]), m(c.from[1])],
      to: [m(c.to[0]), m(c.to[1])],
      widthM: m(c.widthMm),
      riseM: m(c.riseMm),
      steps: c.stepCount,
      handrail: c.hasHandrail,
    })),
    objects: scene.objects.map((o, i) => ({
      trackId: i + 1,
      label: o.label,
      spaceKey: o.spaceId === null ? null : key(o.spaceId),
      at: [m(o.transform.position[0]), m(o.transform.position[2])],
      yawDeg: o.transform.yawDeg,
      sizeM: [m(o.size.w), m(o.size.d), m(o.size.h)],
      aboveFloorM: m(o.transform.position[1]),
    })),
    exits: scene.portals.map((p) => ({
      key: key(p.id),
      at: [m(p.at[0]), m(p.at[1])],
      alongDeg: p.yawDeg,
      widthM: m(p.widthMm),
      label: p.label,
    })),
  };
}

/**
 * Offline city author: answers with the sample city, so the city harness, place building and
 * everything downstream run in tests without a model.
 */
export function fakeCityAuthor(
  calls: FakeCalls = fakeCalls(),
  city: CitySpec = sampleCity,
): CityAuthor & { calls: FakeCalls } {
  return {
    calls,
    model: model("city-author"),
    prompt: "Write the city as CityDraft JSON.",
    revisePrompt: "Fix the findings.",
    effort: "none",
    async author() {
      calls.author++;
      return draftOfCity(city);
    },
    async revise(_brief: CityBrief, previous: CityDraft) {
      calls.revise++;
      return structuredClone(previous);
    },
  };
}

/** Offline look critic: everything reads perfectly, so offline harnesses never loop on looks. */
export function fakeLookCritic(): LookCritic & { calls: number } {
  const critic = {
    calls: 0,
    model: model("look-critic"),
    prompt: "Judge the tiles.",
    effort: "none",
    async critique(_sheet: Uint8Array, items: readonly LookItem[]) {
      critic.calls++;
      return { tiles: items.map((i) => ({ index: i.index, score: 10, fixes: [] })) };
    },
  };
  return critic;
}

/** Offline look designer: hands the look back unchanged. */
export function fakeLookDesigner(): LookDesigner & { calls: number } {
  const designer = {
    calls: 0,
    model: model("look-designer"),
    prompt: "Redesign the look.",
    effort: "none",
    async redesign(request: LookDesignRequest) {
      designer.calls++;
      return structuredClone(request.current);
    },
  };
  return designer;
}
