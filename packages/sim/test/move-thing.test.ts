/** Moving a thing by hand: what physics refuses, what it can't shut off, what goes with it. */
import type { ObjectId, Scene } from "@aye/schema";
import { sampleFlat, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import {
  buildNavGrid,
  canBeMoved,
  carriedBy,
  footingCheck,
  moveThing,
  moveThings,
  Sim,
  solidity,
  standingCheck,
} from "../src/index.ts";

const floorThing = sampleFlat.objects.find(
  (o) => canBeMoved(o) && sampleSpec.things.some((t) => t.object === o.id),
)!;
const [x0 = 0, , z0 = 0] = floorThing.transform.position;

/** Somewhere near where it is that it can stand: found, not hardcoded to this fixture. */
function aSpot() {
  for (let r = 100; r <= 3000; r += 100) {
    for (const [dx, dz] of [
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
    ] as const) {
      const yawDeg = Math.round(floorThing.transform.yawDeg);
      const m = moveThing(sampleFlat, sampleSpec, floorThing.id, {
        xMm: x0 + dx,
        zMm: z0 + dz,
        yawDeg,
      });
      if (m.ok) return { xMm: x0 + dx, zMm: z0 + dz, yawDeg };
    }
  }
  throw new Error("nowhere to move it in the fixture");
}

describe("where someone can stand", () => {
  const fits = footingCheck(sampleFlat, sampleSpec, 100);
  const room = sampleFlat.spaces[0]!;
  const xs = room.polygon.map((p) => p[0] as number);
  const zs = room.polygon.map((p) => p[1] as number);

  it("says no outside the place and in its walls", () => {
    expect(fits(-5000, -5000)).toBe(false);
    const wall = sampleFlat.walls[0]!;
    expect(fits(wall.a[0], wall.a[1])).toBe(false);
  });

  it("agrees there's floor to stand on somewhere in a room", () => {
    let any = false;
    for (let x = Math.min(...xs); x < Math.max(...xs); x += 200) {
      for (let z = Math.min(...zs); z < Math.max(...zs); z += 200) any ||= fits(x, z);
    }
    expect(any).toBe(true);
  });
});

describe("moving a thing by hand", () => {
  it("moves it, keeps what it is, and changes nothing else", () => {
    const to = aSpot();
    const m = moveThing(sampleFlat, sampleSpec, floorThing.id, to);
    if (!m.ok) throw new Error(m.reason);
    const after = m.scene.objects.find((o) => o.id === floorThing.id)!;
    expect(after.transform.position[0]).toBe(to.xMm);
    expect(after.transform.position[2]).toBe(to.zMm);
    expect(after.label).toBe(floorThing.label);
    expect(after.size).toEqual(floorThing.size);
    expect(m.scene.objects).toHaveLength(sampleFlat.objects.length);
    expect(m.scene.walls).toEqual(sampleFlat.walls);
  });

  it("knows the whole of a room is the room, whichever way its outline was drawn", () => {
    const room = sampleFlat.spaces[0]!;
    const xs = room.polygon.map((p) => p[0] as number);
    const zs = room.polygon.map((p) => p[1] as number);
    const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
    const [minZ, maxZ] = [Math.min(...zs), Math.max(...zs)];
    const square = (points: [number, number][]): Scene => ({
      ...sampleFlat,
      spaces: [{ ...room, polygon: points }],
      walls: [],
      openings: [],
      portals: [],
      levelChanges: [],
      objects: [{ ...floorThing, spaceId: room.id, size: { w: 200, h: 200, d: 200 } }],
    });
    const box: [number, number][] = [
      [minX, minZ],
      [maxX, minZ],
      [maxX, maxZ],
      [minX, maxZ],
    ];
    for (const polygon of [box, [...box].reverse()]) {
      const scene = square(polygon);
      // The middle of every side, just inside it.
      for (const [xMm, zMm] of [
        [minX + 300, (minZ + maxZ) >> 1],
        [maxX - 300, (minZ + maxZ) >> 1],
        [(minX + maxX) >> 1, minZ + 300],
        [(minX + maxX) >> 1, maxZ - 300],
      ] as const) {
        const m = moveThing(scene, sampleSpec, floorThing.id, { xMm, zMm, yawDeg: 0 });
        expect(m.ok ? "fits" : m.reason).toBe("fits");
      }
    }
  });

  it("says no by hand to going through a wall, even for what may stand against one", () => {
    const loose = {
      ...sampleSpec,
      kinds: sampleSpec.kinds.map((k) => ({ ...k, solid: false })),
    };
    const wall = sampleFlat.walls[0]!;
    const [ax = 0, az = 0] = wall.a;
    const [bx = 0, bz = 0] = wall.b;
    const m = moveThing(sampleFlat, loose, floorThing.id, {
      xMm: Math.round((ax + bx) / 2),
      zMm: Math.round((az + bz) / 2),
      yawDeg: 0,
    });
    expect(m.ok).toBe(false);
  });

  it("the check a drag asks is never kinder than the move itself", () => {
    const check = standingCheck(sampleFlat, sampleSpec, floorThing.id)!;
    const [minX, maxX] = [-1000, 12_000];
    for (let xMm = minX; xMm <= maxX; xMm += 700) {
      for (let zMm = minX; zMm <= maxX; zMm += 700) {
        const to = { xMm, zMm, yawDeg: 0 };
        const moved = moveThing(sampleFlat, sampleSpec, floorThing.id, to);
        // If the quick check says no, the move has to as well, with the same reason.
        const quick = check(to);
        if (quick) expect(moved).toEqual({ ok: false, reason: quick });
      }
    }
  });

  it("takes several moves together, or none of them", () => {
    const to = aSpot();
    const first = { object: floorThing.id, ...to };
    const there = moveThings(sampleFlat, sampleSpec, [
      first,
      { object: floorThing.id, xMm: x0, zMm: z0, yawDeg: to.yawDeg },
    ]);
    if (!there.ok) throw new Error(there.reason);
    // Moved and moved back: once in the list, where it ended up.
    expect(there.moved.map((o) => o.id)).toEqual([floorThing.id]);
    expect(there.moved[0]?.transform.position[0]).toBe(x0);
    // The last can't go there, so the first doesn't happen either.
    expect(
      moveThings(sampleFlat, sampleSpec, [
        first,
        { object: floorThing.id, xMm: 9_000_000, zMm: 0, yawDeg: 0 },
      ]),
    ).toMatchObject({ ok: false });
    expect(moveThings(sampleFlat, sampleSpec, [])).toMatchObject({ ok: true, moved: [] });
  });

  it("gives the same scene every time", () => {
    const to = aSpot();
    expect(moveThing(sampleFlat, sampleSpec, floorThing.id, to)).toEqual(
      moveThing(sampleFlat, sampleSpec, floorThing.id, to),
    );
  });

  it("really is somewhere else to anyone walking", () => {
    const to = aSpot();
    const m = moveThing(sampleFlat, sampleSpec, floorThing.id, to);
    if (!m.ok) throw new Error(m.reason);
    const level = sampleFlat.levels[0]!.id;
    const isSolid = solidity(sampleSpec);
    const a = buildNavGrid(sampleFlat, level, { cellMm: 100, isSolid });
    const b = buildNavGrid(m.scene, level, { cellMm: 100, isSolid });
    if (isSolid(floorThing)) expect(b.flags).not.toEqual(a.flags);
  });

  it("refuses outside the place and through walls", () => {
    expect(
      moveThing(sampleFlat, sampleSpec, floorThing.id, { xMm: 9_000_000, zMm: 0, yawDeg: 0 }),
    ).toMatchObject({ ok: false });
    expect(
      moveThing(sampleFlat, sampleSpec, floorThing.id, { xMm: -5000, zMm: -5000, yawDeg: 0 }),
    ).toMatchObject({ ok: false });
  });

  it("refuses numbers that aren't positions, and things that aren't there", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 1e12]) {
      expect(
        moveThing(sampleFlat, sampleSpec, floorThing.id, { xMm: bad, zMm: z0, yawDeg: 0 }),
      ).toMatchObject({ ok: false });
    }
    expect(
      moveThing(sampleFlat, sampleSpec, "obj_nothing" as ObjectId, {
        xMm: x0,
        zMm: z0,
        yawDeg: 0,
      }),
    ).toMatchObject({ ok: false });
  });

  /** A scene with something standing on the thing, and something hung on the wall above it. */
  const stacked = (): Scene => {
    const [x = 0, , z = 0] = floorThing.transform.position;
    const top = floorThing.size.h;
    return {
      ...sampleFlat,
      objects: [
        ...sampleFlat.objects,
        {
          ...floorThing,
          id: "obj_rider" as ObjectId,
          label: "rider",
          size: { w: 100, h: 100, d: 100 },
          transform: { position: [x, top, z], yawDeg: 0 },
        },
        {
          ...floorThing,
          id: "obj_hung" as ObjectId,
          label: "hung",
          size: { w: 100, h: 100, d: 100 },
          transform: { position: [x, top + 900, z], yawDeg: 0 },
        },
      ],
    };
  };

  it("carries what rests on it, and leaves what's only above it", () => {
    const scene = stacked();
    expect(carriedBy(scene, floorThing.id).map((o) => o.id)).toEqual(["obj_rider"]);
    const to = aSpot();
    const m = moveThing(scene, sampleSpec, floorThing.id, to);
    if (!m.ok) throw new Error(m.reason);
    const rider = m.scene.objects.find((o) => o.id === "obj_rider")!;
    expect(rider.transform.position[0]).toBe(to.xMm);
    expect(rider.transform.position[2]).toBe(to.zMm);
    const hung = m.scene.objects.find((o) => o.id === "obj_hung")!;
    expect(hung.transform.position[0]).toBe(x0);
  });

  it("won't pick up something that's off the floor", () => {
    expect(
      moveThing(stacked(), sampleSpec, "obj_rider" as ObjectId, { xMm: x0, zMm: z0, yawDeg: 0 }),
    ).toEqual({ ok: false, reason: "That's fixed where it is." });
  });
});

describe("steering is a stream of walks", () => {
  const start = () => {
    const sim = new Sim({ scene: sampleFlat, spec: sampleSpec, settings: sampleSettings });
    const agent = sampleSpec.people[0]?.key as string;
    const slot = sim.slotOf(agent);
    return { sim, agent, slot };
  };

  it("loses no ground to being asked again on the way", () => {
    const one = start();
    const many = start();
    const [x0 = 0, z0 = 0] = one.sim.position(one.slot);
    // Somewhere it can walk to, a good way off: wherever the sim will take it.
    let target: [number, number] | null = null;
    for (const [dx, dz] of [
      [3000, 0],
      [-3000, 0],
      [0, 3000],
      [0, -3000],
    ] as const) {
      const probe = start();
      probe.sim.step([{ type: "walk", agent: probe.agent, x: x0 + dx, z: z0 + dz }]);
      if (probe.sim.mode[probe.slot] === 1) {
        target = [x0 + dx, z0 + dz];
        break;
      }
    }
    if (!target) throw new Error("nowhere to walk in the fixture");
    const [x, z] = target;
    const ticks = 60;
    one.sim.step([{ type: "walk", agent: one.agent, x, z }]);
    many.sim.step([{ type: "walk", agent: many.agent, x, z }]);
    for (let t = 1; t < ticks; t++) {
      one.sim.step([]);
      // As a held key does: asked again several times a second.
      many.sim.step(t % 6 === 0 ? [{ type: "walk", agent: many.agent, x, z }] : []);
    }
    expect(many.sim.position(many.slot)).toEqual(one.sim.position(one.slot));
    expect(start().sim.hash()).toBe(start().sim.hash());
  });
});
