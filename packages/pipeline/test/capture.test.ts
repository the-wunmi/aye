/**
 * Tests for the capture providers: parsing SAM's output, the segmenter, pixel redaction, and
 * reading Muse's map into the pipeline's contract.
 */
import { MemoryArtifactStore } from "@aye/artifacts";
import type { CaptureId } from "@aye/schema";
import { describe, expect, it } from "vitest";
import {
  assembleScene,
  type FrameSet,
  type MusePlace,
  metaSegmenter,
  PRIVATE_TRACK_BASE,
  parseSamOutput,
  pixelate,
  pixelRedactor,
  placeToUnderstanding,
} from "../src/index.ts";
import { decodePng, encodePng } from "../src/png.ts";

const key = "LLM_123_supersecretvalue";

describe("parseSamOutput", () => {
  it("reads boxes by key, per frame, with and without confidence", () => {
    const text = [
      "<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|><|mask;x=0;y=0;data=27,60,~!!!!M!0c|>,1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|><|mask;x=0;y=0;data=27,48,~zz|>",
      "<2f>1<|box;x1=444;y1=625;x2=679;y2=850;w=1800;h=1200;c=0.96|><|mask;x=0;y=0;c=0.96;data=226,236,!abc|>",
    ].join("\n");
    const boxes = parseSamOutput(text);
    expect(boxes).toHaveLength(3);
    expect(boxes[0]).toMatchObject({ frame: 0, id: 0, x1: 211, y2: 254, w: 320, confidence: null });
    expect(boxes[2]).toMatchObject({ frame: 2, id: 1, confidence: 0.96 });
  });

  it("skips anything malformed or out of range instead of trusting it", () => {
    const hostile = [
      "no frame marker 0<|box;x1=1;y1=1;x2=2;y2=2;w=10;h=10|>",
      "<0f>0<|box;x1=-5;y1=1;x2=2;y2=2;w=10;h=10|>",
      "<0f>0<|box;x1=1;y1=1;x2=99999999;y2=2;w=10;h=10|>",
      "<0f>0<|box;x1=1;y1=1;x2=2;y2=2;w=0;h=10|>",
      "<0f>0<|box;x1=1;y1=1;x2=2;y2=2;w=10;h=10;c=7|>",
    ].join("\n");
    const boxes = parseSamOutput(hostile);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.confidence).toBeNull();
  });
});

describe("metaSegmenter", () => {
  it("turns SAM detections into private tracks, keeping the key out of everything", async () => {
    const store = new MemoryArtifactStore();
    const image = await store.put(
      await encodePng({ width: 4, height: 4, data: new Uint8Array(64).fill(200) }),
      "image/png",
    );
    const sse = (text: string) =>
      new Response(
        `event: x\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: ${JSON.stringify({ type: "response.completed" })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const bodies: string[] = [];
    const segmenter = metaSegmenter(
      {
        apiKey: key,
        textModel: "muse-spark-1.3",
        fetch: async (_url, init) => {
          bodies.push(String((init as RequestInit).body));
          return sse("<0f>0<|box;x1=1;y1=1;x2=3;y2=3;w=4;h=4|><|mask;x=0;y=0;data=2,2,~a|>");
        },
      },
      ["face"],
    );
    const frames: FrameSet = { frames: [{ index: 0, timeMs: 0, image }], widthPx: 4, heightPx: 4 };
    const { tracks } = await segmenter.track(frames, {
      store,
      seed: 1,
      signal: new AbortController().signal,
    });
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ private: true, concept: "face", bbox: [1, 1, 2, 2] });
    expect(tracks[0]?.trackId).toBeGreaterThanOrEqual(PRIVATE_TRACK_BASE);
    expect(bodies.join("")).not.toContain(key);
    expect(JSON.parse(bodies[0] as string).model).toBe("sam-3.1");
  });
});

describe("pixelRedactor", () => {
  it("replaces private boxes with flat blocks and leaves everything else alone", async () => {
    const store = new MemoryArtifactStore();
    const width = 40;
    const height = 20;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      data.set([(i * 37) % 256, (i * 91) % 256, (i * 13) % 256, 255], i * 4);
    }
    const original = await store.put(await encodePng({ width, height, data }), "image/png");
    const frames: FrameSet = {
      frames: [
        { index: 0, timeMs: 0, image: original },
        { index: 1, timeMs: 100, image: original },
      ],
      widthPx: width,
      heightPx: height,
    };
    const masks = await store.put(new Uint8Array([1]), "text/plain");
    const tracks = {
      tracks: [
        {
          trackId: PRIVATE_TRACK_BASE,
          concept: "face",
          private: true,
          frameStart: 0,
          frameEnd: 0,
          masks,
          bestFrame: 0,
          bbox: [10, 5, 8, 8] as [number, number, number, number],
          confidence: 0.9,
        },
      ],
    };
    const ctx = { store, seed: 1, signal: new AbortController().signal };
    const redacted = await pixelRedactor().redact(frames, tracks, ctx);
    // A frame with nothing private is passed through untouched.
    expect(redacted.frames[1]?.image.hash).toBe(original.hash);
    const out = await decodePng((await store.get(redacted.frames[0]!.image.hash))!, 64);
    const px = (x: number, y: number) => [
      ...out.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3),
    ];
    // Inside the box, neighbours inside one block share a colour; outside, pixels are unchanged.
    expect(px(12, 7)).toEqual(px(13, 7));
    expect(px(0, 0)).toEqual([...data.subarray(0, 3)]);
    expect(px(39, 19)).toEqual([
      ...data.subarray((19 * width + 39) * 4, (19 * width + 39) * 4 + 3),
    ]);
    // Deterministic: the same input gives the same bytes.
    const again = await pixelRedactor().redact(frames, tracks, ctx);
    expect(again.frames[0]?.image.hash).toBe(redacted.frames[0]?.image.hash);
  });

  it("pixelate stays inside the image even for boxes at the edge", () => {
    const image = { width: 8, height: 8, data: new Uint8Array(256).fill(9) };
    expect(() => pixelate(image, [6, 6, 10, 10])).not.toThrow();
  });
});

describe("placeToUnderstanding", () => {
  const place: MusePlace = {
    place: { name: "Market street", summary: "A market street", currency: "NGN" },
    spaces: [
      {
        key: "Main Road!",
        name: "Main road",
        polygon: [
          { x: -4, z: 0 },
          { x: 4, z: 0 },
          { x: 4, z: 40 },
          { x: -4, z: 40 },
        ],
        floorOffsetM: 0,
        outdoor: true,
      },
      {
        key: "stall",
        name: "Stall",
        polygon: [
          { x: 4, z: 10 },
          { x: 7, z: 10 },
          { x: 7, z: 14 },
        ],
        floorOffsetM: 0.15,
        outdoor: false,
      },
    ],
    walls: [{ a: { x: 8, z: 0 }, b: { x: 8, z: 40 }, heightM: 6 }],
    openings: [
      {
        key: "gate",
        kind: "gate",
        at: { x: 8, z: 20 },
        alongDeg: 90,
        clearWidthM: 2,
        outside: "nope",
      },
    ],
    levelChanges: [
      {
        key: "k1",
        kind: "kerb",
        from: { x: 3.5, z: 12 },
        to: { x: 4.5, z: 12 },
        widthM: 2,
        riseM: 0.15,
        steps: 1,
      },
    ],
    objects: [
      {
        label: "food stall",
        space: "stall",
        at: { x: 5.5, z: 12 },
        yawDeg: 270,
        widthM: 2,
        depthM: 1,
        heightM: 2.4,
        aboveFloorM: 0,
      },
      {
        label: "",
        space: "ghost",
        at: { x: 0, z: 5 },
        yawDeg: 0,
        widthM: 0,
        depthM: 0,
        heightM: 0,
        aboveFloorM: 0,
      },
    ],
    exits: [],
  };

  it("makes keys safe, drops dangling references, and numbers objects for identity", () => {
    const u = placeToUnderstanding(place);
    expect(u.spaces.map((s) => s.key)).toEqual(["space_main_road", "space_stall"]);
    expect(u.spaces[1]?.outdoor).toBe(false);
    expect(u.objects.map((o) => o.trackId)).toEqual([1, 2]);
    expect(u.objects[0]?.spaceKey).toBe("space_stall");
    expect(u.objects[1]?.spaceKey).toBeNull();
    expect(u.objects[1]?.label).toBe("thing");
    // An opening onto an unknown space opens onto the first outdoor space instead.
    expect(u.openings[0]?.between[0]).toBe("space_main_road");
    expect(u.levelChanges[0]?.kind).toBe("kerb");
  });

  it("assembles into a playable scene with an arrival point even without exits", () => {
    const scene = assembleScene({
      captureId: "cap_testplace" as CaptureId,
      understanding: placeToUnderstanding(place),
      tracks: { tracks: [] },
    });
    expect(scene.portals).toHaveLength(1);
    expect(scene.entry).toBe(scene.portals[0]?.id);
    // Things carry only identity and geometry; what they are is the world spec's business.
    expect(scene.objects.find((o) => o.label === "food stall")).toBeDefined();
  });
});
