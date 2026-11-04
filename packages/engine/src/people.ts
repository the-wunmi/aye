/**
 * People, drawn as their look says: a figure a model built from primitives (or a player chose
 * from their city's looks), coloured with the person's own colours. Code only rigs it: each
 * body part becomes one mesh that pivots where it joins (arms at the shoulder, legs at the
 * hip, the head at the neck), found from the part's own shapes, and moves with the sim: arms
 * and legs swing in step with the distance walked, the body bobs, people sit and lie down,
 * and vanish into whatever they're inside.
 *
 * A wheelchair is drawn for seated bodies: a rendering of the body's physics, not a look.
 */
import type { BodyPart, PersonDef, PersonLook } from "@aye/schema";
import * as THREE from "three/webgpu";
import { colourOutfit, type Library } from "./library.ts";
import { mergeSolids, type PlacedSolid, vertexColoured } from "./solids.ts";

/** Pose indices, matching POSES in @aye/sim; 255 means walking or idle. */
const POSE = { stand: 0, sit: 1, lie: 2, inside: 3 } as const;

export interface Person {
  root: THREE.Group;
  /**
   * Advance the walk cycle, heading and pose from the latest position (metres). `face` (a
   * heading in radians) turns them to face that way, as when seated on something.
   */
  update(x: number, y: number, z: number, dt: number, pose: number, face?: number): void;
  dispose(): void;
}

/** For people from before looks existed only: a plain figure in their colours. */
const PLAIN: PersonLook = {
  heightMm: 1700,
  parts: [
    {
      part: "body",
      shapes: [
        {
          shape: "rounded_box",
          centre: [0, 1150, 0],
          size: [360, 520, 220],
          rotateDeg: [0, 0, 0],
          colour: "top",
        },
      ],
    },
    {
      part: "head",
      shapes: [
        {
          shape: "sphere",
          centre: [0, 1590, 0],
          size: [220, 250, 230],
          rotateDeg: [0, 0, 0],
          colour: "skin",
        },
      ],
    },
    {
      part: "arm_left",
      shapes: [
        {
          shape: "capsule",
          centre: [-235, 1140, 0],
          size: [95, 580, 95],
          rotateDeg: [0, 0, 0],
          colour: "top",
        },
      ],
    },
    {
      part: "arm_right",
      shapes: [
        {
          shape: "capsule",
          centre: [235, 1140, 0],
          size: [95, 580, 95],
          rotateDeg: [0, 0, 0],
          colour: "top",
        },
      ],
    },
    {
      part: "leg_left",
      shapes: [
        {
          shape: "capsule",
          centre: [-90, 445, 0],
          size: [125, 890, 125],
          rotateDeg: [0, 0, 0],
          colour: "bottom",
        },
      ],
    },
    {
      part: "leg_right",
      shapes: [
        {
          shape: "capsule",
          centre: [90, 445, 0],
          size: [125, 890, 125],
          rotateDeg: [0, 0, 0],
          colour: "bottom",
        },
      ],
    },
  ],
};

function colourOf(c: string, colours: PersonDef["colours"]): string {
  switch (c) {
    case "skin":
      return colours.skin;
    case "top":
      return colours.top;
    case "bottom":
      return colours.bottom;
    case "hair":
      return colours.hair ?? "#1a1310";
    case "accent":
      return colours.accent ?? "#f2e6c9";
    default:
      return c;
  }
}

/** Where a part joins the body, in metres: from its own shapes' bounds. */
function pivotOf(part: BodyPart, shapes: PersonLook["parts"][number]["shapes"]): THREE.Vector3 {
  if (part === "body" || shapes.length === 0) return new THREE.Vector3();
  let [minX, maxX, minY, maxY, minZ, maxZ] = [
    Infinity,
    -Infinity,
    Infinity,
    -Infinity,
    Infinity,
    -Infinity,
  ];
  for (const s of shapes) {
    minX = Math.min(minX, s.centre[0] - s.size[0] / 2);
    maxX = Math.max(maxX, s.centre[0] + s.size[0] / 2);
    minY = Math.min(minY, s.centre[1] - s.size[1] / 2);
    maxY = Math.max(maxY, s.centre[1] + s.size[1] / 2);
    minZ = Math.min(minZ, s.centre[2] - s.size[2] / 2);
    maxZ = Math.max(maxZ, s.centre[2] + s.size[2] / 2);
  }
  const x = (minX + maxX) / 2000;
  const z = (minZ + maxZ) / 2000;
  // Limbs hang from their top; the head sits on its bottom.
  const y = part === "head" ? minY / 1000 : (maxY - Math.min(60, (maxY - minY) * 0.08)) / 1000;
  return new THREE.Vector3(x, y, z);
}

const chair = {
  wheel: new THREE.TorusGeometry(0.28, 0.025, 10, 32),
  seat: new THREE.BoxGeometry(0.5, 0.05, 0.45),
  back: new THREE.BoxGeometry(0.5, 0.45, 0.04),
};

export function createPerson(def: Pick<PersonDef, "key" | "colours" | "look" | "body">): Person {
  const look = def.look ?? PLAIN;
  const seated = def.body.seated;
  const material = vertexColoured(0.7);
  const geometries: THREE.BufferGeometry[] = [];
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const groups = new Map<BodyPart, { group: THREE.Group; pivot: THREE.Vector3 }>();
  for (const p of look.parts) {
    const pivot = pivotOf(p.part, p.shapes);
    const solids: PlacedSolid[] = p.shapes.map((s) => ({
      primitive: s.shape,
      position: [
        s.centre[0] / 1000 - pivot.x,
        s.centre[1] / 1000 - pivot.y,
        s.centre[2] / 1000 - pivot.z,
      ],
      scale: [s.size[0] / 1000, s.size[1] / 1000, s.size[2] / 1000],
      rotateDeg: s.rotateDeg,
      colour: colourOf(s.colour, def.colours),
    }));
    const geometry = mergeSolids(solids, 0.6);
    geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    const group = new THREE.Group();
    group.position.copy(pivot);
    group.add(mesh);
    body.add(group);
    groups.set(p.part, { group, pivot });
  }
  const limb = (part: BodyPart) => groups.get(part)?.group ?? null;
  const arms = [limb("arm_left"), limb("arm_right")];
  const legs = [limb("leg_left"), limb("leg_right")];
  const head = limb("head");
  const hipY =
    legs.reduce((y, l) => Math.max(y, l?.position.y ?? 0), 0) || (look.heightMm / 1000) * 0.52;

  const chairParts: THREE.Material[] = [];
  if (seated) {
    // Seated on wheels: the figure sits on the chair seat, legs forward.
    const frame = new THREE.MeshStandardNodeMaterial({ color: "#3a3f44", roughness: 0.4 });
    const tyre = new THREE.MeshStandardNodeMaterial({ color: "#161616", roughness: 0.9 });
    chairParts.push(frame, tyre);
    const wheelchair = new THREE.Group();
    for (const x of [-0.3, 0.3]) {
      const w = new THREE.Mesh(chair.wheel, tyre);
      w.rotation.y = Math.PI / 2;
      w.position.set(x, 0.3, -0.05);
      wheelchair.add(w);
    }
    const seat = new THREE.Mesh(chair.seat, frame);
    seat.position.y = 0.5;
    const back = new THREE.Mesh(chair.back, frame);
    back.position.set(0, 0.75, -0.22);
    wheelchair.add(seat, back);
    root.add(wheelchair);
  }

  let phase = Math.random() * Math.PI * 2;
  let heading = 0;
  let last: THREE.Vector3 | null = null;
  let breath = Math.random() * 10;

  const sitDown = () => {
    body.position.y = 0.5 - hipY;
    for (const l of legs) if (l) l.rotation.x = -Math.PI / 2;
    for (const a of arms) if (a) a.rotation.x = -0.35;
  };
  if (seated) sitDown();

  return {
    root,
    update(x, y, z, dt, pose, face) {
      root.position.set(x, y, z);
      root.visible = pose !== POSE.inside;
      const here = new THREE.Vector3(x, 0, z);
      const moved = last ? here.distanceTo(last) : 0;
      if (face !== undefined) {
        heading = face;
      } else if (last && moved > 1e-4) {
        const target = Math.atan2(x - last.x, z - last.z);
        let delta = target - heading;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        heading += delta * Math.min(1, dt * 10);
      }
      last = here;
      root.rotation.y = heading;
      breath += dt;
      if (seated) return;

      body.rotation.set(0, 0, 0);
      body.position.set(0, 0, 0);
      if (head) head.rotation.set(0, 0, 0);
      for (const l of legs) if (l) l.rotation.set(0, 0, 0);
      for (const a of arms) if (a) a.rotation.set(0, 0, 0);
      if (pose === POSE.lie) {
        body.rotation.x = -Math.PI / 2;
        body.position.set(0, 0.5, hipY);
        return;
      }
      if (pose === POSE.sit) {
        body.position.y = 0.45 - hipY;
        for (const l of legs) if (l) l.rotation.x = -Math.PI / 2;
        for (const a of arms) if (a) a.rotation.x = -0.45;
        if (head) head.rotation.y = Math.sin(breath * 0.4) * 0.25;
        return;
      }
      const speed = moved / Math.max(dt, 1e-3);
      phase += moved * 4.4;
      const swing = Math.min(1, speed / 1.2) * 0.5;
      const s = Math.sin(phase) * swing;
      if (legs[0]) legs[0].rotation.x = s;
      if (legs[1]) legs[1].rotation.x = -s;
      if (arms[0]) arms[0].rotation.x = -s * 0.8;
      if (arms[1]) arms[1].rotation.x = s * 0.8;
      // A step's bob when walking; a breath and a look around when standing.
      body.position.y =
        swing > 0.05 ? Math.abs(Math.cos(phase)) * 0.025 : Math.sin(breath * 1.6) * 0.004;
      if (swing <= 0.05 && head) head.rotation.y = Math.sin(breath * 0.3) * 0.2;
    },
    dispose() {
      material.dispose();
      for (const g of geometries) g.dispose();
      for (const m of chairParts) m.dispose();
    },
  };
}

// ── Rigged people ─────────────────────────────────────────────────────────────

/** How long one reach for a thing in use lasts, seconds. */
const REACH_S = 2.4;

/** Bone names as the loader sanitises them, compared loosely ("UpperLeg.L" → "upperlegl"). */
const boneKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A person drawn from a rigged library outfit in their own colours, animated by the shared
 * clips: walking and running with their speed, working when using something, idle otherwise;
 * sitting and lying bend the skeleton. Until the outfit loads (or if it can't), they are the
 * primitive figure, so nobody is ever invisible.
 */
export function createLivePerson(
  def: Pick<PersonDef, "key" | "colours" | "look" | "body" | "outfit">,
  library: Library | null,
): Person {
  const plain = createPerson(def);
  if (!def.outfit || !library) return plain;
  const root = new THREE.Group();
  root.add(plain.root);
  let rig: {
    holder: THREE.Group;
    mixer: THREE.AnimationMixer;
    actions: Map<string, THREE.AnimationAction>;
    current: THREE.AnimationAction | null;
    bones: Map<string, THREE.Object3D>;
    materials: THREE.Material[];
  } | null = null;
  let disposed = false;
  const seated = def.body.seated;
  const wheelchair = seated ? createPerson({ ...def, look: EMPTY_LOOK }) : null;

  void library.outfit(def.outfit).then((outfit) => {
    if (!outfit || disposed) return;
    const materials = colourOutfit(outfit, def.colours);
    const holder = new THREE.Group();
    const height = (def.look?.heightMm ?? 1750) / 1000;
    holder.scale.setScalar(height / (outfit.asset.heightMm / 1000));
    holder.add(outfit.root);
    const mixer = new THREE.AnimationMixer(outfit.root);
    const actions = new Map<string, THREE.AnimationAction>();
    for (const [purpose, clip] of outfit.clips) actions.set(purpose, mixer.clipAction(clip));
    const bones = new Map<string, THREE.Object3D>();
    outfit.root.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones.set(boneKey(o.name), o);
    });
    root.remove(plain.root);
    plain.dispose();
    root.add(holder);
    if (wheelchair) root.add(wheelchair.root);
    rig = { holder, mixer, actions, current: null, bones, materials };
  });

  let heading = 0;
  let last: THREE.Vector3 | null = null;
  /** Seconds into using something standing: they reach now and then, not all the time. */
  let busyFor = 0;
  /** A personal rhythm (from their key), so a room of people doesn't gesture in step. */
  const rhythm = (() => {
    let h = 0;
    for (const c of def.key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return 7 + (h % 500) / 100;
  })();
  const play = (purpose: string, timeScale: number) => {
    if (!rig) return;
    const next = rig.actions.get(purpose) ?? rig.actions.get("idle") ?? null;
    if (next && next !== rig.current) {
      next.reset().play();
      if (rig.current) next.crossFadeFrom(rig.current, 0.25, false);
      rig.current = next;
    }
    if (rig.current) rig.current.timeScale = timeScale;
  };
  /**
   * Bend a joint about the person's own left–right axis (so "thigh forward" means forward
   * whatever the rig's bone axes are): the rotation is taken from the body's frame into the
   * bone's, through its parent's current world orientation.
   */
  const across = new THREE.Vector3();
  const parentQ = new THREE.Quaternion();
  const turn = new THREE.Quaternion();
  const bend = (name: string, angle: number) => {
    const b = rig?.bones.get(name);
    if (!b?.parent) return;
    root.updateMatrixWorld(true);
    across.set(1, 0, 0).applyQuaternion(root.getWorldQuaternion(turn));
    b.parent.getWorldQuaternion(parentQ);
    const local = across.clone().applyQuaternion(parentQ.clone().invert());
    b.quaternion.premultiply(turn.setFromAxisAngle(local, angle));
  };

  return {
    root,
    update(x, y, z, dt, pose, face) {
      if (!rig) {
        // Still the primitive figure: let it move and turn, then carry that on our root (so
        // callers always read where this person is from `root`).
        plain.update(x, y, z, dt, pose, face);
        root.position.copy(plain.root.position);
        root.rotation.y = plain.root.rotation.y;
        root.visible = plain.root.visible;
        heading = plain.root.rotation.y;
        plain.root.position.set(0, 0, 0);
        plain.root.rotation.y = 0;
        plain.root.visible = true;
        return;
      }
      root.position.set(x, y, z);
      root.visible = pose !== POSE.inside;
      const here = new THREE.Vector3(x, 0, z);
      const moved = last ? here.distanceTo(last) : 0;
      if (face !== undefined) {
        heading = face;
      } else if (last && moved > 1e-4) {
        const target = Math.atan2(x - last.x, z - last.z);
        let delta = target - heading;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        heading += delta * Math.min(1, dt * 10);
      }
      last = here;
      root.rotation.y = heading;
      const speed = moved / Math.max(dt, 1e-3);
      const sitting = seated || pose === POSE.sit;
      busyFor = pose === POSE.stand ? busyFor + dt : 0;
      if (sitting || pose === POSE.lie) play("idle", 0.6);
      else if (pose === POSE.stand) {
        // Reach for the thing when they start, then every few seconds; idle in between.
        play(busyFor % rhythm < REACH_S ? "interact" : "idle", 0.8);
      } else if (speed > 3.2) play("run", Math.min(2.2, speed / 5));
      else if (speed > 0.15) play("walk", Math.min(2.4, Math.max(0.7, speed / 1.4)));
      else play("idle", 1);
      rig.mixer.update(dt);
      rig.holder.rotation.set(0, 0, 0);
      rig.holder.position.set(0, 0, 0);
      if (sitting) {
        // Thighs forward, shins down: seated on whatever is under them.
        for (const side of ["l", "r"]) {
          bend(`upperleg${side}`, -Math.PI / 2);
          bend(`lowerleg${side}`, Math.PI / 2);
        }
        rig.holder.position.y = seated ? 0.05 : -0.42;
      } else if (pose === POSE.lie) {
        // Face up, centred on where they are: head behind the heading, feet ahead; their
        // back on the surface under them.
        rig.holder.rotation.x = -Math.PI / 2;
        rig.holder.position.set(0, 0.15, 0.85);
      }
    },
    dispose() {
      disposed = true;
      if (rig) {
        rig.mixer.stopAllAction();
        for (const m of rig.materials) m.dispose();
      } else {
        plain.dispose();
      }
      wheelchair?.dispose();
    },
  };
}

/** No body at all: used to draw only the wheelchair a seated body comes with. */
const EMPTY_LOOK: PersonLook = { heightMm: 1700, parts: [] };
