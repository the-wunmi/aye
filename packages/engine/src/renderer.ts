/**
 * three.js renderer for a place: a view of the simulation, never a source of truth.
 *
 * Everything it draws comes from data. Ground and walls take the colours of the place's world
 * spec; each thing is drawn from the simple shapes its kind's `look` describes, and shapes with
 * conditions appear only in the state they belong to (a car's cover only while it is covered,
 * a door swung out while open). Nothing here knows what any thing is. The style is a clean,
 * toy-like representation: flat colours, soft light, real proportions, nothing photoreal.
 *
 * Walls drop to stubs so the inside can be seen: all of them when the whole place is in view,
 * those between the camera and the person it follows otherwise.
 * Clicks become intents for the game to send: a thing (show what it can do), a person (take
 * them over), the floor (walk there). A thing picked up can be dragged (5 cm snap), with its
 * ring saying whether it can stay; the renderer only ever *proposes* where it goes.
 * People are drawn per simulation slot, so they come and go as the server says.
 *
 * WebGPU first (`three/webgpu` falls back to WebGL2). Rendering may use floating-point maths
 * freely: it never feeds back into the deterministic simulation.
 */
import {
  type Condition,
  dayPhase,
  type PersonDef,
  type Scene,
  type Shape,
  type Sun,
  type WorldSpec,
} from "@aye/schema";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { builtinAOContext, mrt, normalView, pass, screenUV } from "three/tsl";
import * as THREE from "three/webgpu";
import { interpolatePositions } from "./interpolate.ts";
import { fitInto, getLibrary, type Library } from "./library.ts";
import { createLivePerson, type Person } from "./people.ts";
import {
  CAMERA_DAMPING,
  PLACE_LOOKS,
  type PlaceLook,
  qualityGovernor,
  startingLevel,
} from "./quality.ts";
import { primitiveGeometry } from "./solids.ts";
import { startRenderer } from "./start-renderer.ts";
import { type Footing, type Predicted, predict } from "./steer.ts";

const MM = 1 / 1000;

/** A spot to point out: where it is, how big, and how far above the floor it is. */
export interface SpotMark {
  xMm: number;
  zMm: number;
  radiusMm: number;
  aboveFloorMm?: number;
}

/** A box's faces in three.js order (+x, -x, +y, -y, +z, -z), as turns bringing +z round to them. */
const FACE_YAW = [Math.PI / 2, -Math.PI / 2, 0, 0, 0, Math.PI];

/** How much floor or wall one repeat of a filmed place's picture of it covers, in metres. */
const PHOTO_TILE_M = 1.5;

/** The overall colour of a picture (for the sides of a box wearing it on its front). */
function averageColour(tex: THREE.Texture): THREE.Color {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const c = canvas.getContext("2d", { willReadFrequently: true });
  if (!c) return new THREE.Color("#b0a898");
  c.drawImage(tex.image as CanvasImageSource, 0, 0, 1, 1);
  const [r = 176, g = 168, b = 152] = c.getImageData(0, 0, 1, 1).data;
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
}

/**
 * A picture without the plain border a model may leave around what it drew: the part that
 * differs from its corners. Sampled small: this only has to find the edges.
 */
function trimmed(tex: THREE.Texture): THREE.Texture {
  const SIZE = 64;
  const TOLERANCE = 28;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const c = canvas.getContext("2d", { willReadFrequently: true });
  if (!c) return tex;
  c.drawImage(tex.image as CanvasImageSource, 0, 0, SIZE, SIZE);
  const px = c.getImageData(0, 0, SIZE, SIZE).data;
  const [r0 = 0, g0 = 0, b0 = 0] = px;
  let minX = SIZE;
  let minY = SIZE;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const away =
        Math.abs((px[i] as number) - r0) +
        Math.abs((px[i + 1] as number) - g0) +
        Math.abs((px[i + 2] as number) - b0);
      if (away > TOLERANCE) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  // All one colour, nothing to take off, or so much that it isn't a border.
  if (maxX < 0 || w < SIZE / 2 || h < SIZE / 2 || (w === SIZE && h === SIZE)) return tex;
  const out = tex.clone();
  out.repeat.set(w / SIZE, h / SIZE);
  out.offset.set(minX / SIZE, 1 - (minY + h) / SIZE);
  out.needsUpdate = true;
  return out;
}

/**
 * A box of this size, standing on its base, with a picture on one side (a box face index) and,
 * if there is one, a picture of its top.
 */
function pictureBox(
  tex: THREE.Texture,
  w: number,
  h: number,
  d: number,
  face: number,
  topTex: THREE.Texture | null,
): THREE.Mesh {
  const side = new THREE.MeshStandardNodeMaterial({ color: averageColour(tex), roughness: 0.8 });
  const front = new THREE.MeshStandardNodeMaterial({ map: trimmed(tex), roughness: 0.7 });
  const top = topTex ? new THREE.MeshStandardNodeMaterial({ map: topTex, roughness: 0.5 }) : side;
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    [0, 1, 2, 3, 4, 5].map((i) => (i === face ? front : i === 2 ? top : side)),
  );
  box.position.y = h / 2;
  box.castShadow = true;
  box.receiveShadow = true;
  return box;
}
const CUTAWAY_HEIGHT_M = 0.35;
/** How far someone walks before the walls are cut again around them. */
const RECUT_AFTER_M = 1.5;
const DOOR_HEAD_M = 2.1;
const SNAP_MM = 50;
const DRAG_THRESHOLD_PX = 4;
/** A fingertip wobbles more than a mouse: this far is still a tap. */
const TOUCH_TAP_PX = 12;
/** A finger hides what it taps: on a miss, look this far around it for a thing or a person. */
const TOUCH_REACH_PX = 16;
const TOUCH_AROUND: readonly (readonly [number, number])[] = [
  [0, -1],
  [0.7, -0.7],
  [1, 0],
  [0.7, 0.7],
  [0, 1],
  [-0.7, 0.7],
  [-1, 0],
  [-0.7, -0.7],
];
/** How far above someone's feet the follow camera looks. */
const FOLLOW_AIM_M = 1.2;
/** How closely the follow camera keeps up, per second: close enough to feel attached to them. */
const FOLLOW_PER_S = 7;
/** How quickly people are drawn catching up with where they are, per second. */
const PEOPLE_EASE_PER_S = 12;
/** Further than this between one update and the next isn't walking: draw it as it is. */
const PEOPLE_JUMP_MM = 2_500;

export interface AgentFrame {
  /** x, z per person in mm. */
  positions: Float32Array;
  modes: Uint8Array;
  /** Pose index per person (see POSES in @aye/sim), 255 when idle or walking. */
  poses: Uint8Array;
  /** The thing each person sits or lies at or on (object id), or "". */
  using?: readonly string[];
  /** Per person: 1 on the thing itself, 0 beside it, 2 unsaid (judged by its height). */
  on?: Uint8Array;
}

/** The world's state as the renderer needs it: thing vars, who's away, what's available. */
export interface StateFrame {
  thingVars: Int32Array;
  thingAway: Uint8Array;
  resourcesOn: Uint8Array;
}

/** Where each thing's vars live in `thingVars`, and which kind it is. From the realm server. */
export interface ThingLayout {
  id: string;
  kind: string;
  base: number;
}

export type PlacementCheck = (
  objectId: string,
) => ((xMm: number, zMm: number, yawDeg: number) => boolean) | null;

export interface Renderer {
  readonly backend: "webgpu" | "webgl2";
  /** Build the place and its things under a world spec. `keepCamera` keeps the view. */
  loadScene(
    scene: Scene,
    spec: WorldSpec | null,
    opts?: { keepCamera?: boolean; things?: readonly ThingLayout[]; resources?: readonly string[] },
  ): void;
  /** Who is in each simulation slot (null for an empty slot). */
  setPeople(people: readonly (PersonDef | null)[]): void;
  /** The slot of the person the player is (ringed), or null. */
  setYou(slot: number | null): void;
  /** Sun, sky and light for this minute, by the city's sunrise and sunset (absent: a default). */
  setTime(minuteOfDay: number, sun?: Sun): void;
  /** The ground around the place, in the city's land colour. */
  setSurroundings(colour: string): void;
  /** Keep the camera on this person (a slot), closer in; null for the whole place. */
  follow(slot: number | null): void;
  /** Where someone can stand, for walking your own character before the server answers. */
  setFooting(fits: Footing): void;
  /** Walk this person now, on this device only; a null way stops them. */
  steer(slot: number | null, way: { dx: number; dz: number; speedMmPerS: number } | null): void;
  /** Mark these things as ones that can be moved, or nothing. */
  setMovable(objects: readonly string[]): void;
  /** How it's keeping up: for looking at on a real device. */
  speed(): {
    fps: number;
    level: number;
    drawCalls: number;
    triangles: number;
    you: { xMm: number; zMm: number } | null;
  };
  /**
   * Rearranging: pressing a thing `grab` accepts picks it up and dragging slides it, with what
   * rests on it. Pressing anything else moves the camera as usual. Null ends it.
   */
  setRearranging(
    rules: {
      grab(object: string): string | null;
      carried(object: string): readonly string[];
    } | null,
  ): void;
  /** Stand these things where they say, without redrawing the place: a draft, undone at will. */
  placeThings(objects: readonly Scene["objects"][number][]): void;
  /** A thing was dragged and let go here. A proposal: nothing has moved until the place says. */
  onDrop(
    listener: (object: string, to: { xMm: number; zMm: number; yawDeg: number }) => void,
  ): void;
  /** Push the latest sim frame; positions are interpolated from the previous one. */
  setAgents(frame: AgentFrame): void;
  /** Push the latest thing and resource state; looks follow it. */
  setState(state: StateFrame): void;
  setPlacementCheck(check: PlacementCheck | null): void;
  setSelected(objectId: string | null): void;
  /** Bring a spot into view: the place seen from the spot's side, walls there cut away. */
  showSpot(xMm: number, zMm: number): void;
  /** Spots to point out on the floor, in scene millimetres; [] clears them. */
  setMarks(marks: readonly SpotMark[]): void;
  /** Orbit the camera by eighth turns around the point it looks at (eased). */
  rotate(eighthTurns: number): void;
  /** Where a person is drawn now (interpolated), in millimetres, or null. */
  whereIs(slot: number): { x: number; z: number } | null;
  /** Which way the camera looks across the floor: a unit vector (x, z), for steering. */
  facing(): { x: number; z: number };
  /** A click on a thing (or on nothing: null). */
  onSelect(listener: (objectId: string | null) => void): void;
  /** The pointer moved onto a thing (or off everything: null). */
  onHover(listener: (objectId: string | null) => void): void;
  /** A click on a person, by slot. */
  onPerson(listener: (slot: number) => void): void;
  /** A click on the floor, in millimetres. */
  onGround(listener: (xMm: number, zMm: number) => void): void;
  /** Where on the canvas (CSS pixels) a person's head or a thing's top is, or null. */
  screenOfPerson(slot: number): { x: number; y: number } | null;
  screenOfThing(objectId: string): { x: number; y: number } | null;
  resize(): void;
  dispose(): void;
}

function pointInPolygon(
  x: number,
  z: number,
  poly: readonly (readonly [number, number])[],
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i] as readonly [number, number];
    const [xj, zj] = poly[j] as readonly [number, number];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** One drawn shape and the state it belongs to. */
interface ShapeView {
  mesh: THREE.Mesh;
  when: readonly Condition[];
  /** Shown in the thing's starting state: what a library model draws instead, once loaded. */
  base: boolean;
}

interface ThingView {
  root: THREE.Group;
  shapes: ShapeView[];
  /** Var key → index within the thing's kind. */
  vars: Map<string, number>;
  /** A library model stands in for the base shapes. */
  modelled: boolean;
  /**
   * Where the model's tall parts sit (a seat's backrest), as x/z in the thing's own frame,
   * metres from its centre; null if it has none to speak of.
   */
  back: [number, number] | null;
}

/**
 * Overhead parts (an awning's canvas, a canopy, a big umbrella): broad and entirely above
 * head height. The camera looks down into places, so these go on a layer it doesn't draw,
 * the way walls drop for the cutaway; their posts stay, and so do small things up high (a
 * ceiling fan, a sign). Nothing about the place changes: this is only what the camera sees.
 */
const OVERHEAD_LAYER = 1;
const OVERHEAD_MIN_Y_M = 1.6;
const OVERHEAD_MIN_AREA_M2 = 1;
function hideOverhead(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const box = new THREE.Box3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (!bb) return;
    box.copy(bb).applyMatrix4(new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld));
    const area = (box.max.x - box.min.x) * (box.max.z - box.min.z);
    if (box.min.y >= OVERHEAD_MIN_Y_M && area >= OVERHEAD_MIN_AREA_M2) {
      mesh.layers.set(OVERHEAD_LAYER);
    }
  });
}

/** The centre of a model's upper parts, in `frame`'s coordinates (x, z), or null. */
function upperCentre(model: THREE.Object3D, frame: THREE.Object3D): [number, number] | null {
  frame.updateMatrixWorld(true);
  const toFrame = new THREE.Matrix4().copy(frame.matrixWorld).invert();
  const v = new THREE.Vector3();
  const points: THREE.Vector3[] = [];
  let top = -Infinity;
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const pos = mesh.isMesh ? mesh.geometry.getAttribute("position") : undefined;
    if (!pos) return;
    const m = new THREE.Matrix4().multiplyMatrices(toFrame, mesh.matrixWorld);
    const stride = Math.max(1, Math.floor(pos.count / 400));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      points.push(v.clone());
      top = Math.max(top, v.y);
    }
  });
  const high = points.filter((p) => p.y > top * 0.7);
  if (high.length === 0) return null;
  let x = 0;
  let z = 0;
  for (const p of high) {
    x += p.x;
    z += p.z;
  }
  return [x / high.length, z / high.length];
}

export async function createRenderer(
  canvas: HTMLCanvasElement,
  opts: {
    library?: Library | null;
    /** Where an artifact (a filmed place's pictures) can be read from. */
    artifactUrl?: (hash: string) => string;
  } = {},
): Promise<Renderer> {
  const library = opts.library === undefined ? getLibrary() : opts.library;
  /** Bumped per scene load, so late library loads for an old scene are dropped. */
  let generation = 0;
  const renderer = await startRenderer(canvas);
  const backendInfo = renderer.backend as { isWebGPUBackend?: boolean };
  const backend = backendInfo.isWebGPUBackend ? "webgpu" : "webgl2";
  const governor = qualityGovernor(startingLevel(), PLACE_LOOKS.length - 1);
  const lookNow = () => PLACE_LOOKS[governor.level] as PlaceLook;
  const pixelRatioFor = (look: PlaceLook) =>
    Math.min(look.maxPixelRatio, globalThis.devicePixelRatio || 1);
  renderer.setPixelRatio(pixelRatioFor(lookNow()));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 600);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = CAMERA_DAMPING;
  controls.minDistance = 3;
  controls.maxDistance = 120;
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = 1.35;
  controls.screenSpacePanning = false;

  // Soft daylight: a warm sun with shadows and a sky/ground fill, plus a generated studio
  // environment (no files) so textured library models get reflections and read as solid.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = environment;
  scene.environmentIntensity = 0.45;
  const hemi = new THREE.HemisphereLight(0xfff6e8, 0x8a7d6a, 1.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe7c4, 2.2);
  sun.castShadow = true;
  // A phone's small screen can't show what a bigger map would add.
  sun.shadow.mapSize.setScalar(startingLevel() > 0 ? 1024 : 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  const world = new THREE.Group();
  const thingsGroup = new THREE.Group();
  const peopleGroup = new THREE.Group();
  scene.add(world, thingsGroup, peopleGroup);

  // The place sits in its surroundings: wide ground in the city's land colour, fading into
  // the sky with distance.
  const groundMat = new THREE.MeshStandardNodeMaterial({ color: "#c9c2b2", roughness: 1 });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 64), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.17;
  ground.receiveShadow = true;
  scene.add(ground);
  scene.background = new THREE.Color("#cfe3ee");
  scene.fog = new THREE.Fog("#cfe3ee", 60, 260);

  /** Sun, sky and light follow the city's clock: low warm sun at dawn and dusk, night blue. */
  function setTime(minuteOfDay: number, sunTimes?: Sun): void {
    const phase = dayPhase(sunTimes, minuteOfDay);
    // 0 at night, rising through the morning to 1 at noon.
    const day = Math.max(0, Math.sin(phase * Math.PI));
    const golden = Math.max(0, 1 - day * 2.2);
    // Night is a blue hour, not a blackout: cool, bright enough to play by, lights glowing.
    const night = new THREE.Color("#141c38");
    const dawn = new THREE.Color("#f2c49b");
    const noon = new THREE.Color("#cfe3ee");
    const sky = night
      .clone()
      .lerp(dawn, Math.min(1, day * 3))
      .lerp(noon, Math.max(0, day * 1.4 - 0.4));
    (scene.background as THREE.Color).copy(sky);
    scene.fog?.color.copy(sky);
    sun.intensity = 0.6 + 1.9 * day;
    sun.color
      .set("#b8c8f0")
      .lerp(new THREE.Color("#ffad66"), Math.min(1, day * 4) * golden)
      .lerp(new THREE.Color("#fff1d9"), Math.max(0, day * 1.6 - 0.6));
    hemi.intensity = 1.15 + 0.85 * day;
    scene.environmentIntensity = 0.2 + 0.3 * day;
    hemi.color.set("#fff6e8").lerp(new THREE.Color("#8fa3d6"), 1 - day);
    const angle = phase * Math.PI;
    const up = Math.sin(angle);
    sunDirection.set(-Math.cos(angle), up > 0.15 ? up : 0.7, 0.45).normalize();
    fitSun();
  }
  const sunDirection = new THREE.Vector3(-0.55, 0.62, 0.45).normalize();

  // Soft ambient occlusion (GTAO) where supported; plain rendering otherwise.
  let pipeline: THREE.RenderPipeline | null = null;
  try {
    if (!lookNow().ambientOcclusion) throw new Error("not at this level");
    pipeline = new THREE.RenderPipeline(renderer);
    // Depth and normals for occlusion, without multisampling (GTAO reads plain depth).
    const prePass = pass(scene, camera, { samples: 0 });
    prePass.setMRT(mrt({ output: normalView }));
    const occlusion = ao(prePass.getTextureNode("depth"), prePass.getTextureNode(), camera);
    occlusion.resolutionScale = 0.5;
    const scenePass = pass(scene, camera);
    scenePass.contextNode = builtinAOContext(occlusion.getTextureNode().sample(screenUV).r);
    pipeline.outputNode = scenePass;
  } catch {
    pipeline = null;
  }

  // ── Materials: one per colour, shared ────────────────────────────────────────────────
  const materials = new Map<string, THREE.Material>();
  const material = (colour: string) => {
    let m = materials.get(colour);
    if (!m) {
      m = new THREE.MeshStandardNodeMaterial({ color: colour, roughness: 0.8 });
      materials.set(colour, m);
    }
    return m;
  };
  /** Unlit, for lamps, screens, signs and flames: they shine at night. */
  const glowMaterials = new Map<string, THREE.Material>();
  const glowMaterial = (colour: string) => {
    let m = glowMaterials.get(colour);
    if (!m) {
      m = new THREE.MeshBasicNodeMaterial({ color: colour });
      glowMaterials.set(colour, m);
    }
    return m;
  };
  const selectionMaterial = new THREE.MeshBasicNodeMaterial({
    color: 0x2f6fde,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });

  // ── Camera ───────────────────────────────────────────────────────────────────────────
  let bounds = new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 0, 5));
  let cutSector = -1;

  /** Arrive at a three-quarter angle; long places (streets) are seen across, not along. */
  function frame(): void {
    const centre = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z) * 0.62 + 1;
    // The field of view is vertical: held upright, a phone sees much less across, so stand back.
    const distance =
      radius / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(1, camera.aspect));
    // ...and the haze keeps its distance too, or the whole place washes out.
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.near = 60 / Math.min(1, camera.aspect);
      scene.fog.far = 260 / Math.min(1, camera.aspect);
    }
    const entry = loaded?.portals.find((p) => p.id === loaded?.entry) ?? loaded?.portals[0];
    let azimuth = Math.PI / 4;
    const elongated = Math.max(size.x, size.z) > 1.6 * Math.min(size.x, size.z);
    if (elongated) {
      azimuth = (size.z > size.x ? Math.PI / 2 : 0) + Math.PI / 8;
    } else if (entry) {
      const ex = entry.at[0] * MM - centre.x;
      const ez = entry.at[1] * MM - centre.z;
      if (Math.hypot(ex, ez) > 0.1) azimuth = Math.atan2(ex, ez) + Math.PI / 6;
    }
    const elevation = 0.75;
    const dir = new THREE.Vector3(
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
      Math.cos(elevation) * Math.cos(azimuth),
    );
    controls.target.copy(centre);
    camera.position.copy(centre).addScaledVector(dir, distance);
    controls.maxDistance = Math.max(60, distance * 2);
    controls.update();
  }

  function fitSun(): void {
    const centre = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.z) * 0.75 + 2;
    sun.position.copy(centre).add(sunDirection.clone().multiplyScalar(r * 2));
    sun.target.position.copy(centre);
    const cam = sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 0.5;
    cam.far = r * 5;
    cam.updateProjectionMatrix();
  }

  function resize(): void {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  /** Turn the view by eighth turns, eased in the frame loop. */
  let turnLeft = 0;
  function rotate(eighthTurns: number): void {
    turnLeft += (-eighthTurns * Math.PI) / 4;
  }

  /** Which way the camera looks from, in 8 sectors; walls are re-cut when it changes. */
  function cameraSector(): number {
    const v = camera.position.clone().sub(controls.target);
    return (Math.round(Math.atan2(v.x, v.z) / (Math.PI / 4)) + 8) % 8;
  }

  // ── Building the place ───────────────────────────────────────────────────────────────
  let loaded: Scene | null = null;
  let spec: WorldSpec | null = null;
  let resourceKeys: readonly string[] = [];
  /** Each thing's layout plus its index in the sim's thing order (for `thingAway`). */
  let layout = new Map<string, ThingLayout & { index: number }>();
  const thingViews = new Map<string, ThingView>();
  let wallMesh: THREE.Mesh | null = null;
  let trimMesh: THREE.Mesh | null = null;
  let glassMesh: THREE.Mesh | null = null;
  const glass = new THREE.MeshStandardNodeMaterial({
    color: "#cfe9f5",
    roughness: 0.05,
    metalness: 0.1,
    transparent: true,
    opacity: 0.38,
  });
  let lastState: StateFrame | null = null;

  /** The height of the floor here, metres; null where there's no floor. */
  function floorHere(xMm: number, zMm: number): number | null {
    if (!loaded) return null;
    let floor: number | null = null;
    for (const s of loaded.spaces) {
      if (pointInPolygon(xMm, zMm, s.polygon)) floor = s.floorOffsetMm * MM;
    }
    return floor;
  }

  function floorAt(xMm: number, zMm: number): number {
    return floorHere(xMm, zMm) ?? 0;
  }

  /**
   * How high someone walking here is: the floor, or how far up a flight of stairs or a ramp
   * they've got, so they climb it rather than jumping from one floor to the next.
   */
  function walkHeightAt(xMm: number, zMm: number): number {
    for (const l of loaded?.levelChanges ?? []) {
      const dx = l.to[0] - l.from[0];
      const dz = l.to[1] - l.from[1];
      const run = Math.hypot(dx, dz);
      if (run === 0 || l.riseMm <= 0) continue;
      const along = ((xMm - l.from[0]) * dx + (zMm - l.from[1]) * dz) / run;
      const across = Math.abs(((xMm - l.from[0]) * dz - (zMm - l.from[1]) * dx) / run);
      if (along < 0 || along > run || across > l.widthMm / 2) continue;
      const low = Math.min(floorAt(l.from[0], l.from[1]), floorAt(l.to[0], l.to[1]));
      return low + (l.riseMm * MM * along) / run;
    }
    return floorAt(xMm, zMm);
  }

  /** Remove children and dispose geometry this renderer built per scene. */
  function clearGroup(group: THREE.Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((o) => {
        if (o instanceof THREE.Mesh && o.userData["owned"]) o.geometry.dispose();
      });
    }
  }

  function buildGround(s: Scene): void {
    const colours = new Map(spec?.ground.map((g) => [g.space as string, g.colour]) ?? []);
    const photos = new Map(
      spec?.ground.flatMap((g) => (g.photo ? [[g.space as string, g.photo] as const] : [])) ?? [],
    );
    const surfaces = new Map(
      spec?.ground.flatMap((g) => (g.surface ? [[g.space as string, g.surface] as const] : [])) ??
        [],
    );
    const minFloor = Math.min(0, ...s.spaces.map((sp) => sp.floorOffsetMm)) * MM;
    const base = minFloor - 0.15;
    // The surrounding ground is below the lowest floor, or it would cover a sunken one.
    ground.position.y = minFloor - 0.17;
    for (const space of s.spaces) {
      const top = space.floorOffsetMm * MM;
      const shape = new THREE.Shape(
        space.polygon.map(([x, z]) => new THREE.Vector2(x * MM, -z * MM)),
      );
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: top - base, bevelEnabled: false });
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, base, 0);
      const colour = colours.get(space.id) ?? (space.ceilingMm === null ? "#a9a59c" : "#e4ddd0");
      const mesh = new THREE.Mesh(geometry, material(colour));
      mesh.userData["owned"] = true;
      mesh.receiveShadow = true;
      world.add(mesh);
      const photo = photos.get(space.id);
      const surface = surfaces.get(space.id);
      if (photo) dressPhoto(mesh, photo);
      else if (surface) dress(mesh, surface, colour);
    }
  }

  /**
   * Steps, stairs and ramps, drawn from what the scene says they are: how far they rise, in how
   * many steps, over how long a run. It's the thing you'd look for in a place, so it should
   * look like what it is.
   */
  let crossings: THREE.Group | null = null;
  function buildCrossings(s: Scene): void {
    if (crossings) {
      world.remove(crossings);
      crossings.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      crossings = null;
    }
    // Two shades, turn about: that's what makes steps read as steps from above.
    const parts: THREE.BufferGeometry[][] = [[], []];
    const m = new THREE.Matrix4();
    for (const l of s.levelChanges) {
      if (l.riseMm <= 0) continue;
      const dx = (l.to[0] - l.from[0]) * MM;
      const dz = (l.to[1] - l.from[1]) * MM;
      const run = Math.hypot(dx, dz);
      if (run === 0) continue;
      const low = Math.min(floorAt(l.from[0], l.from[1]), floorAt(l.to[0], l.to[1]));
      const yaw = Math.atan2(dx, dz);
      const steps = l.kind === "ramp" ? 24 : Math.max(1, l.stepCount);
      // A ramp is a stair of many small steps: reads as a slope, with the same geometry.
      for (let i = 0; i < steps; i++) {
        const t = (i + 0.5) / steps;
        const h = (l.riseMm * MM * (i + 1)) / steps;
        const g = new THREE.BoxGeometry(l.widthMm * MM, h, run / steps + 0.002);
        m.makeRotationY(yaw).setPosition(
          l.from[0] * MM + dx * t,
          low + h / 2,
          l.from[1] * MM + dz * t,
        );
        g.applyMatrix4(m);
        (parts[i % 2] as THREE.BufferGeometry[]).push(g);
      }
    }
    if (parts[0]?.length === 0) return;
    crossings = new THREE.Group();
    parts.forEach((list, shade) => {
      if (list.length === 0) return;
      const mesh = new THREE.Mesh(mergeBoxes(list), material(shade ? "#b8b2a6" : "#e2ddd2"));
      for (const p of list) p.dispose();
      mesh.userData["owned"] = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      crossings?.add(mesh);
    });
    world.add(crossings);
  }

  const meshLoader = new GLTFLoader();
  const meshes = new Map<string, Promise<THREE.Group | null>>();
  /** A rebuilt thing's model: a fresh copy each time, because one place can have it twice. */
  async function rebuilt(hash: string): Promise<THREE.Object3D | null> {
    let p = meshes.get(hash);
    if (!p) {
      const url = opts.artifactUrl?.(hash);
      p = url
        ? meshLoader.loadAsync(url).then(
            (g) => g.scene,
            () => null,
          )
        : Promise.resolve(null);
      meshes.set(hash, p);
    }
    const scene = await p;
    if (!scene) return null;
    const copy = scene.clone(true);
    copy.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        // These files don't say how metallic they are, and glTF's default is entirely. Everything
        // in a room seen on film has its light already in its picture: nothing here is a mirror.
        for (const material of [m.material].flat()) {
          (material as THREE.MeshStandardMaterial).metalness = 0;
        }
      }
    });
    return copy;
  }

  /** A picture of the real thing (an artifact), once loaded; null if it can't be. */
  const pictures = new Map<string, Promise<THREE.Texture | null>>();
  function picture(hash: string): Promise<THREE.Texture | null> {
    let p = pictures.get(hash);
    if (!p) {
      const url = opts.artifactUrl?.(hash);
      p = url
        ? new THREE.TextureLoader().loadAsync(url).then(
            (t) => {
              t.colorSpace = THREE.SRGBColorSpace;
              return t;
            },
            () => null,
          )
        : Promise.resolve(null);
      pictures.set(hash, p);
    }
    return p;
  }

  /** Give a floor or wall a picture of the real one, tiled (UVs are metres). */
  function dressPhoto(mesh: THREE.Mesh, hash: string): void {
    const at = generation;
    void picture(hash).then((tex) => {
      if (!tex || at !== generation) return;
      const map = tex.clone();
      map.wrapS = THREE.RepeatWrapping;
      map.wrapT = THREE.RepeatWrapping;
      map.repeat.set(1 / PHOTO_TILE_M, 1 / PHOTO_TILE_M);
      map.needsUpdate = true;
      mesh.material = new THREE.MeshStandardNodeMaterial({ map, roughness: 0.8 });
    });
  }

  /** Give a floor or wall mesh a library surface once its texture is in (UVs are metres). */
  const surfaceMaterials = new Map<string, THREE.Material>();
  function dress(mesh: THREE.Mesh, surface: string, colour: string): void {
    const at = generation;
    void library?.surface(surface).then((tex) => {
      if (!tex || at !== generation) return;
      const key = `${surface}|${tex.tintable ? colour : ""}`;
      let m = surfaceMaterials.get(key);
      if (!m) {
        const map = tex.map.clone();
        map.repeat.set(1 / tex.tileM, 1 / tex.tileM);
        map.needsUpdate = true;
        m = new THREE.MeshStandardNodeMaterial({
          map,
          color: tex.tintable ? colour : "#ffffff",
          roughness: 0.85,
        });
        surfaceMaterials.set(key, m);
      }
      mesh.material = m;
    });
  }

  function buildWalls(s: Scene): void {
    for (const old of [wallMesh, trimMesh, glassMesh]) {
      if (old) {
        world.remove(old);
        old.geometry.dispose();
      }
    }
    const trims: THREE.BufferGeometry[] = [];
    const panes: THREE.BufferGeometry[] = [];
    // Cut around whoever the camera is following. Seeing the whole place, every wall drops: from
    // up there any wall left standing hides a room, and anyone in it.
    const followed = following === null ? null : people[following];
    const centre = followed
      ? new THREE.Vector3(followed.person.root.position.x, 0, followed.person.root.position.z)
      : bounds.getCenter(new THREE.Vector3());
    cutAround.copy(centre);
    const look = camera.position.clone().sub(controls.target).setY(0).normalize();
    const pieces: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4();
    for (const wall of s.walls) {
      const [ax, az] = wall.a;
      const [bx, bz] = wall.b;
      const len = Math.hypot(bx - ax, bz - az);
      if (len === 0) continue;
      const ux = (bx - ax) / len;
      const uz = (bz - az) / len;
      const mid = new THREE.Vector3(((ax + bx) / 2) * MM, 0, ((az + bz) / 2) * MM);
      const cut = !followed || mid.clone().sub(centre).setY(0).dot(look) > 0.3;
      // A wall stands on the lowest floor beside it, and rises its height above the highest:
      // between two levels it's one wall, and outside it there may be no floor at all.
      const sides = [
        floorHere((ax + bx) / 2 + uz * 200, (az + bz) / 2 - ux * 200),
        floorHere((ax + bx) / 2 - uz * 200, (az + bz) / 2 + ux * 200),
      ].filter((f): f is number => f !== null);
      const baseY = sides.length > 0 ? Math.min(...sides) : 0;
      const topY = sides.length > 0 ? Math.max(...sides) : 0;
      const fullHeight = wall.heightMm * MM + (topY - baseY);
      const height = cut ? Math.min(CUTAWAY_HEIGHT_M + (topY - baseY), fullHeight) : fullHeight;
      const openings = s.openings
        .filter((o) => o.wallId === wall.id)
        .map((o) => {
          const t = (o.at[0] - ax) * ux + (o.at[1] - az) * uz;
          return { t0: t - o.clearWidthMm / 2, t1: t + o.clearWidthMm / 2, o };
        })
        .sort((p, q) => p.t0 - q.t0);
      const box = (
        into: THREE.BufferGeometry[],
        t0: number,
        t1: number,
        y0: number,
        y1: number,
        thickM: number,
      ) => {
        if (t1 - t0 < 1 || y1 - y0 < 0.001) return;
        const along = (t0 + t1) / 2;
        m.makeRotationY(-Math.atan2(uz, ux)).setPosition(
          (ax + ux * along) * MM,
          baseY + (y0 + y1) / 2,
          (az + uz * along) * MM,
        );
        const g = new THREE.BoxGeometry((t1 - t0) * MM, y1 - y0, thickM);
        g.applyMatrix4(m);
        into.push(g);
      };
      const thick = wall.thicknessMm * MM;
      // Each stretch of wall gets a cap along its top, so walls read as solid when cut away.
      const piece = (t0: number, t1: number, y0: number, y1: number) => {
        box(pieces, t0, t1, y0, y1, thick);
        if (y1 - y0 > 0.05) box(trims, t0, t1, y1 - 0.03, y1 + 0.005, thick + 0.02);
      };
      let cursor = 0;
      for (const { t0, t1, o } of openings) {
        piece(cursor, t0, 0, height);
        if (!cut) {
          const head =
            o.kind === "window"
              ? (o.sillMm + o.heightMm) * MM
              : Math.min(DOOR_HEAD_M, o.heightMm * MM);
          piece(t0, t1, head, height);
          if (o.kind === "window") {
            piece(t0, t1, 0, o.sillMm * MM);
            box(panes, t0, t1, o.sillMm * MM, head, 0.02);
            // A sill that stands proud of the wall on both sides.
            box(trims, t0 - 40, t1 + 40, o.sillMm * MM - 0.04, o.sillMm * MM, thick + 0.08);
          }
        }
        cursor = Math.max(cursor, t1);
      }
      piece(cursor, len, 0, height);
    }
    const merged = mergeBoxes(pieces);
    for (const p of pieces) p.dispose();
    wallMesh = new THREE.Mesh(merged, material(spec?.walls.colour ?? "#f1ece2"));
    wallMesh.userData["owned"] = true;
    wallMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    world.add(wallMesh);
    if (spec?.walls.photo) dressPhoto(wallMesh, spec.walls.photo);
    else if (spec?.walls.surface) dress(wallMesh, spec.walls.surface, spec.walls.colour);
    const wallColour = new THREE.Color(spec?.walls.colour ?? "#f1ece2");
    const trimColour = `#${wallColour.clone().multiplyScalar(0.78).getHexString()}`;
    if (trims.length > 0) {
      trimMesh = new THREE.Mesh(mergeBoxes(trims), material(trimColour));
      trimMesh.userData["owned"] = true;
      trimMesh.castShadow = true;
      world.add(trimMesh);
    }
    if (panes.length > 0) {
      glassMesh = new THREE.Mesh(mergeBoxes(panes), glass);
      glassMesh.userData["owned"] = true;
      world.add(glassMesh);
    }
    for (const g of [...trims, ...panes]) g.dispose();
  }

  /**
   * Which side of a thing faces the room (a box face: +x -x +z -z): of its long sides (or all
   * four, if it's about square), the one pointing most toward the middle of the place. Looking
   * at the room rather than trusting a yaw: a cabinet's front is whichever side you can walk up
   * to.
   */
  function faceTowardRoom(o: Scene["objects"][number], w: number, d: number): number {
    const points = loaded?.spaces.flatMap((s) => s.polygon) ?? [];
    const n = Math.max(1, points.length);
    const cx = points.reduce((t, p) => t + p[0], 0) / n - o.transform.position[0];
    const cz = points.reduce((t, p) => t + p[1], 0) / n - o.transform.position[2];
    const yaw = (-o.transform.yawDeg * Math.PI) / 180;
    const sides: [number, number, number][] = [
      [0, 1, 0],
      [1, -1, 0],
      [4, 0, 1],
      [5, 0, -1],
    ];
    const candidates = sides.filter(([, nx]) =>
      w > d * 1.1 ? nx === 0 : d > w * 1.1 ? nx !== 0 : true,
    );
    let best = 4;
    let bestDot = Number.NEGATIVE_INFINITY;
    for (const [face, nx, nz] of candidates) {
      // The side's outward direction in the world (the same turn the thing's root gets).
      const wx = nx * Math.cos(yaw) + nz * Math.sin(yaw);
      const wz = -nx * Math.sin(yaw) + nz * Math.cos(yaw);
      const dot = wx * cx + wz * cz;
      if (dot > bestDot) {
        bestDot = dot;
        best = face;
      }
    }
    return best;
  }

  /** A thing, drawn from its kind's look: each shape placed relative to the thing's size. */
  function buildThing(o: Scene["objects"][number]): ThingView {
    const root = new THREE.Group();
    const [x, above, z] = o.transform.position;
    root.position.set(x * MM, floorAt(x, z) + above * MM, z * MM);
    root.rotation.y = (-o.transform.yawDeg * Math.PI) / 180;
    root.userData["objectId"] = o.id;
    const thingDef = spec?.things.find((t) => t.object === o.id);
    const kindKey = layout.get(o.id)?.kind ?? thingDef?.kind;
    const kind = spec?.kinds.find((k) => k.key === kindKey);
    const w = o.size.w * MM;
    const h = o.size.h * MM;
    const d = o.size.d * MM;
    const look: readonly Shape[] = kind?.look ?? [
      {
        shape: "box",
        centre: [0, 500, 0],
        size: [1000, 1000, 1000],
        rotateDeg: [0, 0, 0],
        colour: "#b8ab98",
        glow: false,
        when: [],
      },
    ];
    // Which shapes show as the thing starts: those a library model replaces.
    const start = new Map(kind?.vars.map((v) => [v.key, v.initial]) ?? []);
    for (const st of spec?.things.find((t) => t.object === o.id)?.state ?? []) {
      start.set(st.var, st.value);
    }
    const startsShown = (when: readonly Condition[]) =>
      when.every((c) => !("resource" in c) && compare(start.get(c.var) ?? 0, c.op, c.value));
    const shapes: ShapeView[] = look.map((s) => {
      const mesh = new THREE.Mesh(
        primitiveGeometry(s.shape),
        s.glow ? glowMaterial(s.colour) : material(s.colour),
      );
      mesh.position.set(
        (s.centre[0] / 1000) * w,
        (s.centre[1] / 1000) * h,
        (s.centre[2] / 1000) * d,
      );
      mesh.scale.set(
        Math.max(0.005, (s.size[0] / 1000) * w),
        Math.max(0.005, (s.size[1] / 1000) * h),
        Math.max(0.005, (s.size[2] / 1000) * d),
      );
      mesh.rotation.set(
        THREE.MathUtils.degToRad(s.rotateDeg[0]),
        THREE.MathUtils.degToRad(s.rotateDeg[1]),
        THREE.MathUtils.degToRad(s.rotateDeg[2]),
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      root.add(mesh);
      return { mesh, when: s.when, base: startsShown(s.when) };
    });
    hideOverhead(root);
    const view: ThingView = {
      root,
      shapes,
      vars: new Map(kind?.vars.map((v, i) => [v.key, i]) ?? []),
      modelled: false,
      back: upperCentre(root, root),
    };
    const at = generation;
    const drawn = (added: THREE.Object3D, back?: [number, number] | null) => {
      root.add(added);
      view.modelled = true;
      if (back !== undefined) view.back = back;
      hideOverhead(root);
      if (lastState) applyState(lastState);
      else for (const sv of shapes) if (sv.base) sv.mesh.visible = false;
    };
    const fromLibrary = () => {
      if (!kind?.asset || !library) return;
      void library.thing(kind.asset).then((model) => {
        if (!model || at !== generation) return;
        const fitted = fitInto(model, w, h, d);
        root.add(fitted);
        drawn(fitted, upperCentre(fitted, root));
      });
    };
    const fromPicture = () => {
      const front = thingDef?.front;
      if (!front) {
        fromLibrary();
        return;
      }
      // The real thing: a box wearing a picture of its front, on the side facing the room.
      const topHash = thingDef?.top;
      void Promise.all([picture(front), topHash ? picture(topHash) : null]).then(
        ([tex, topTex]) => {
          if (!tex || at !== generation) return;
          drawn(pictureBox(tex, w, h, d, faceTowardRoom(o, w, d), topTex));
        },
      );
    };
    // The real thing rebuilt in 3D, if it was and it loads; failing that, whatever it had before.
    const meshHash = thingDef?.mesh;
    if (meshHash) {
      void rebuilt(meshHash).then((model) => {
        if (at !== generation) return;
        if (!model) {
          fromPicture();
          return;
        }
        // Rebuilt things face +z. Turn that to the side you can walk up to, then fit it.
        const facing = new THREE.Group();
        facing.add(model);
        facing.rotation.y = FACE_YAW[faceTowardRoom(o, w, d)] ?? 0;
        const fitted = fitInto(facing, w, h, d);
        root.add(fitted);
        drawn(fitted, upperCentre(fitted, root));
      });
    } else {
      fromPicture();
    }
    return view;
  }

  /** Show each shape only in its state; hide things that someone has taken away. */
  function applyState(state: StateFrame): void {
    lastState = state;
    for (const [id, view] of thingViews) {
      const at = layout.get(id);
      view.root.visible = !(at && state.thingAway[at.index]);
      for (const s of view.shapes) {
        if (view.modelled && s.base) {
          s.mesh.visible = false;
          continue;
        }
        s.mesh.visible = s.when.every((c) => {
          if ("resource" in c) {
            const r = resourceKeys.indexOf(c.resource);
            return r >= 0 && state.resourcesOn[r] === 1;
          }
          const v = view.vars.get(c.var);
          if (!at || v === undefined) return false;
          return compare(state.thingVars[at.base + v] ?? 0, c.op, c.value);
        });
      }
    }
  }

  function loadScene(
    s: Scene,
    nextSpec: WorldSpec | null,
    opts: {
      keepCamera?: boolean;
      things?: readonly ThingLayout[];
      resources?: readonly string[];
    } = {},
  ): void {
    loaded = s;
    spec = nextSpec;
    generation++;
    if (opts.things) layout = new Map(opts.things.map((t, index) => [t.id, { ...t, index }]));
    if (opts.resources) resourceKeys = opts.resources;
    moving = null;
    setMovable([]);
    clearGroup(world);
    clearGroup(thingsGroup);
    wallMesh = null;
    trimMesh = null;
    glassMesh = null;
    thingViews.clear();
    bounds = new THREE.Box3();
    for (const [x, z] of s.levels[0]?.footprint ?? []) {
      bounds.expandByPoint(new THREE.Vector3(x * MM, 0, z * MM));
    }
    if (!opts.keepCamera) frame();
    fitSun();
    buildGround(s);
    buildCrossings(s);
    buildWalls(s);
    cutSector = cameraSector();
    for (const o of s.objects) {
      const view = buildThing(o);
      thingViews.set(o.id, view);
      thingsGroup.add(view.root);
    }
    if (lastState) applyState(lastState);
    setSelected(selected);
  }

  // ── People ───────────────────────────────────────────────────────────────────────────
  /** Per slot: the person drawn there and whose they are (key), so unchanged slots persist. */
  let people: ({ key: string; person: Person } | null)[] = [];
  let prev: Float32Array | null = null;
  let next: Float32Array | null = null;
  let poses: Uint8Array = new Uint8Array(0);
  let using: readonly string[] = [];
  let onIt: Uint8Array = new Uint8Array(0);
  let nextAt = 0;
  let frameGap = 1000 / 30;
  let interpolated = new Float32Array(0);
  /** Where each person is drawn: following `interpolated`, without its hops. */
  let shown = new Float32Array(0);
  /** Who's being steered from here, which way, and where this device has walked them. */
  let steerSlot: number | null = null;
  let steering: { dx: number; dz: number; speedMmPerS: number } | null = null;
  let predicted: Predicted | null = null;
  let footing: Footing = () => true;
  let lastDraw = performance.now();
  let you: number | null = null;
  const youRing = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.4, 48), selectionMaterial);
  // Where a tap on the floor sends you: a ring that fades out.
  const markerMaterial = new THREE.MeshBasicNodeMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.26, 40), markerMaterial);
  marker.rotation.x = -Math.PI / 2;
  scene.add(marker);
  let following: number | null = null;
  const cutAround = new THREE.Vector3();
  youRing.rotation.x = -Math.PI / 2;
  youRing.visible = false;
  scene.add(youRing);

  function setPeople(defs: readonly (PersonDef | null)[]): void {
    const nextPeople: ({ key: string; person: Person } | null)[] = defs.map((d, slot) => {
      const old = people[slot];
      // Same person, same outfit: keep them (and their walk). A new outfit redraws them.
      const key = d ? `${d.key}|${d.outfit ?? ""}` : "";
      if (old && d && old.key === key) return old;
      if (old) {
        peopleGroup.remove(old.person.root);
        old.person.dispose();
      }
      if (!d) return null;
      const person = createLivePerson(d, library);
      person.root.userData["slot"] = slot;
      peopleGroup.add(person.root);
      return { key, person };
    });
    for (let slot = defs.length; slot < people.length; slot++) {
      const old = people[slot];
      if (old) {
        peopleGroup.remove(old.person.root);
        old.person.dispose();
      }
    }
    people = nextPeople;
  }

  function setAgents(f: AgentFrame): void {
    const now = performance.now();
    // Averaged, because one late update shouldn't change the pace of everyone on screen.
    if (next) frameGap += (Math.min(400, Math.max(8, now - nextAt)) - frameGap) * 0.2;
    prev = next && next.length === f.positions.length ? next : f.positions;
    next = f.positions;
    poses = f.poses;
    using = f.using ?? [];
    onIt = f.on ?? new Uint8Array(0);
    nextAt = now;
    if (interpolated.length !== f.positions.length) {
      interpolated = new Float32Array(f.positions.length);
    }
  }

  /**
   * Where someone resting on a thing is drawn: on its seat or surface, spread along its
   * length when several share it, facing away from a seat's back (or laid along it). Someone
   * sitting AT a table or desk takes a free seat the world put within reach, facing the
   * table; with none, they stand at it rather than sit on air. The sim keeps bodies on the
   * floor beside what they use (that is physics); this is only drawing.
   */
  const SEAT_MM = 450;
  const SEAT_REACH_MM = 1500;
  const objectById = (id: string) => loaded?.objects.find((ob) => ob.id === id) ?? null;
  const kindOfObject = (id: string) => {
    const key = spec?.things.find((t) => t.object === id)?.kind;
    return spec?.kinds.find((k) => k.key === key) ?? null;
  };
  /** Something people sit on (by what its world says, or, unsaid, by being seat-high). */
  const isSeat = (o: Scene["objects"][number]) =>
    kindOfObject(o.id)?.actions.some((a) => a.pose === "sit" && (a.on ?? o.size.h <= 600)) === true;
  const restsOn = (i: number, o: Scene["objects"][number], pose: number) => {
    const flag = onIt[i] ?? 2;
    return flag === 2 ? o.size.h <= (pose === 2 ? 900 : 600) : flag === 1;
  };

  /** How high a thing's own surface is at a point, mm above its feet; null if nothing's there. */
  const surfaceCache = new Map<string, number | null>();
  const surfaceRay = new THREE.Raycaster();
  function surfaceUnder(id: string, xMm: number, zMm: number): number | null {
    const view = thingViews.get(id);
    if (!view) return null;
    const key = `${id}:${view.modelled}:${Math.round(xMm / 50)}:${Math.round(zMm / 50)}`;
    const known = surfaceCache.get(key);
    if (known !== undefined) return known;
    const meshes: THREE.Object3D[] = [];
    view.root.updateWorldMatrix(true, true);
    view.root.traverseVisible((m) => {
      if ((m as THREE.Mesh).isMesh) meshes.push(m);
    });
    const feet = view.root.getWorldPosition(new THREE.Vector3()).y;
    surfaceRay.set(new THREE.Vector3(xMm * MM, feet + 50, zMm * MM), new THREE.Vector3(0, -1, 0));
    const hit = surfaceRay.intersectObjects(meshes, false)[0];
    const height = hit ? Math.round((hit.point.y - feet) / MM) : null;
    surfaceCache.set(key, height);
    return height;
  }

  /** A spot on `o` for the k-th of n people on it; `ax, az` is where the sim has them. */
  function spotOn(
    o: Scene["objects"][number],
    pose: number,
    k: number,
    n: number,
    ax: number,
    az: number,
  ) {
    const h = o.size.h;
    const [cx, , cz] = o.transform.position;
    const yaw = (o.transform.yawDeg * Math.PI) / 180;
    // The long axis in world x/z (local x when wider than deep).
    const alongX = o.size.w >= o.size.d;
    const long = alongX ? o.size.w : o.size.d;
    const ux = alongX ? Math.cos(yaw) : -Math.sin(yaw);
    const uz = alongX ? Math.sin(yaw) : Math.cos(yaw);
    // Sitting people spread along it; people lying along it lie side by side.
    const t = pose === 2 ? 0 : -long / 2 + (long * (k + 0.5)) / Math.max(1, n);
    const across_ = Math.min(o.size.w, o.size.d);
    const beside = pose === 2 ? -across_ / 2 + (across_ * (k + 0.5)) / Math.max(1, n) : 0;
    const x = cx + ux * t - uz * beside;
    const z = cz + uz * t + ux * beside;
    // On what's actually there: the mattress, not the top of the headboard.
    const under = surfaceUnder(o.id, x, z);
    const surface = under ?? (pose === 2 || h <= 600 ? h : SEAT_MM);
    // Rigs sit with their hips a seat's height above where they stand.
    const y = floorAt(cx, cz) + (pose === 1 ? surface - SEAT_MM : surface) * MM;
    // Seated: facing away from the seat's back (its tall side) when it has one, else out to
    // the side they came from. Lying: along it.
    const back = thingViews.get(o.id)?.back ?? null;
    // The seat's back along its short axis, in the thing's own frame.
    const lean = back ? (alongX ? back[1] : back[0]) : 0;
    const across = Math.min(o.size.w, o.size.d);
    const side =
      Math.abs(lean) * 1000 > across * 0.12
        ? // Normal (-uz, ux) is the frame's +z when the long axis is x, and its -x otherwise.
          alongX
          ? -Math.sign(lean)
          : Math.sign(lean)
        : (ax - cx) * -uz + (az - cz) * ux >= 0
          ? 1
          : -1;
    // Lying, feet point away from the tall end (a headboard), so the head rests against it.
    const headAt = back ? (alongX ? back[0] : back[1]) : 0;
    const feet = Math.abs(headAt) * 1000 > long * 0.1 && headAt < 0 ? 1 : -1;
    const face = pose === 2 ? Math.atan2(ux * feet, uz * feet) : Math.atan2(-uz * side, ux * side);
    return { x, z, y, face };
  }

  function restingSpot(
    i: number,
    sharing: ReadonlyMap<string, readonly number[]>,
    borrowed: ReadonlyMap<number, string>,
  ) {
    const id = using[i];
    const pose = poses[i];
    const o = id ? objectById(id) : null;
    if (!o || (pose !== 1 && pose !== 2)) return null;
    const ax = interpolated[i * 2] as number;
    const az = interpolated[i * 2 + 1] as number;
    const on = (sharing.get(o.id) ?? []).filter((j) => !borrowed.has(j));
    if (restsOn(i, o, pose)) {
      return { ...spotOn(o, pose, Math.max(0, on.indexOf(i)), on.length, ax, az), pose };
    }
    const [cx, , cz] = o.transform.position;
    const seatId = borrowed.get(i);
    const seat = seatId ? objectById(seatId) : null;
    if (seat) {
      const there = [...borrowed].filter(([, s]) => s === seatId).map(([j]) => j);
      const spot = spotOn(seat, 1, there.indexOf(i), there.length, ax, az);
      return { ...spot, face: Math.atan2(cx - spot.x, cz - spot.z), pose: 1 };
    }
    // No seat to hand: standing at it beats sitting on air.
    return { x: ax, z: az, y: floorAt(ax, az), face: Math.atan2(cx - ax, cz - az), pose: 0 };
  }

  /** Free seats near people sitting at tables, nearest first, in slot order. */
  function borrowSeats(): Map<number, string> {
    const borrowed = new Map<number, string>();
    if (!loaded) return borrowed;
    const taken = new Set(using.filter(Boolean));
    const seats = loaded.objects.filter((o) => !taken.has(o.id) && isSeat(o));
    using.forEach((id, i) => {
      const o = id ? objectById(id) : null;
      if (!o || poses[i] !== 1 || restsOn(i, o, 1)) return;
      const ax = interpolated[i * 2] as number;
      const az = interpolated[i * 2 + 1] as number;
      let best: { id: string; d: number } | null = null;
      for (const s of seats) {
        const room = Math.max(1, Math.floor(Math.max(s.size.w, s.size.d) / 550));
        if ([...borrowed.values()].filter((b) => b === s.id).length >= room) continue;
        const d = Math.hypot(s.transform.position[0] - ax, s.transform.position[2] - az);
        if (d <= SEAT_REACH_MM && (!best || d < best.d)) best = { id: s.id, d };
      }
      if (best) borrowed.set(i, best.id);
    });
    return borrowed;
  }

  function updatePeople(dt: number): void {
    if (!prev || !next) return;
    interpolatePositions(prev, next, (performance.now() - nextAt) / frameGap, interpolated);
    // Updates arrive a few times a second and never quite on time: drawing them as they come is
    // a walk in hops. Everyone eases towards where they should be; a real jump stays a jump.
    if (shown.length !== interpolated.length) shown = interpolated.slice();
    const ease = 1 - Math.exp(-dt * PEOPLE_EASE_PER_S);
    for (let i = 0; i + 1 < shown.length; i += 2) {
      const tx = interpolated[i] as number;
      const tz = interpolated[i + 1] as number;
      const sx = shown[i] as number;
      const sz = shown[i + 1] as number;
      const far = Math.hypot(tx - sx, tz - sz) > PEOPLE_JUMP_MM;
      shown[i] = far ? tx : sx + (tx - sx) * ease;
      shown[i + 1] = far ? tz : sz + (tz - sz) * ease;
    }
    // Who rests on each thing, in slot order, so they share it side by side.
    const sharing = new Map<string, number[]>();
    using.forEach((id, i) => {
      if (id) sharing.set(id, [...(sharing.get(id) ?? []), i]);
    });
    const borrowed = borrowSeats();
    people.forEach((p, i) => {
      if (!p) return;
      let x = shown[i * 2] as number;
      let z = shown[i * 2 + 1] as number;
      if (i === steerSlot) {
        predicted = predict(predicted, { x, z }, steering, dt, footing);
        if (predicted) {
          x = predicted.x;
          z = predicted.z;
        }
      }
      const spot = i === steerSlot && predicted ? null : restingSpot(i, sharing, borrowed);
      if (spot) {
        p.person.update(spot.x * MM, spot.y, spot.z * MM, dt, spot.pose, spot.face);
      } else {
        p.person.update(x * MM, walkHeightAt(x, z), z * MM, dt, poses[i] ?? 255);
      }
    });
    const mine = you === null ? null : people[you];
    youRing.visible = Boolean(mine?.person.root.visible);
    if (mine) {
      const r = mine.person.root.position;
      youRing.position.set(r.x, r.y + 0.02, r.z);
    }
  }

  const projected = new THREE.Vector3();
  function toScreen(v: THREE.Vector3): { x: number; y: number } | null {
    projected.copy(v).project(camera);
    if (projected.z > 1 || Math.abs(projected.x) > 1.2 || Math.abs(projected.y) > 1.2) return null;
    return {
      x: ((projected.x + 1) / 2) * canvas.clientWidth,
      y: ((1 - projected.y) / 2) * canvas.clientHeight,
    };
  }

  // ── Selection and dragging ───────────────────────────────────────────────────────────
  let selected: string | null = null;
  let selectionRing: THREE.Mesh | null = null;
  const selectListeners: ((id: string | null) => void)[] = [];

  /** The ring round what's selected or in hand: its colour says if it fits, and nothing else's. */
  const holdMaterial = new THREE.MeshBasicNodeMaterial({
    color: 0x2f6fde,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    depthTest: false,
  });
  const movableGroup = new THREE.Group();
  scene.add(movableGroup);
  const movableMaterial = new THREE.MeshBasicNodeMaterial({
    color: 0x2f6fde,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    depthTest: false,
  });
  function setMovable(objects: readonly string[]): void {
    for (const c of [...movableGroup.children]) {
      movableGroup.remove(c);
      (c as THREE.Mesh).geometry.dispose();
    }
    for (const id of objects) {
      const o = loaded?.objects.find((ob) => ob.id === id);
      const root = thingViews.get(id)?.root;
      if (!o || !root) continue;
      // Its own footprint, so a glance says what can be moved and how much of the floor it takes.
      const patch = new THREE.Mesh(
        new THREE.PlaneGeometry(Math.max(0.3, o.size.w * MM), Math.max(0.3, o.size.d * MM)),
        movableMaterial,
      );
      patch.rotation.order = "YXZ";
      patch.rotation.x = -Math.PI / 2;
      patch.rotation.y = root.rotation.y;
      patch.position.set(root.position.x, root.position.y + 0.02, root.position.z);
      patch.renderOrder = 9;
      patch.userData["thing"] = id;
      movableGroup.add(patch);
    }
  }

  function setSelected(id: string | null): void {
    selected = id;
    if (selectionRing) {
      scene.remove(selectionRing);
      selectionRing.geometry.dispose();
      selectionRing = null;
    }
    const o = loaded?.objects.find((ob) => ob.id === id);
    const root = id ? thingViews.get(id)?.root : undefined;
    if (!o || !root) return;
    const r = Math.hypot(o.size.w, o.size.d) * MM * 0.55;
    selectionRing = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.05, 64), holdMaterial);
    selectionRing.rotation.x = -Math.PI / 2;
    selectionRing.position.set(root.position.x, root.position.y + 0.015, root.position.z);
    selectionRing.renderOrder = 10;
    scene.add(selectionRing);
  }

  function showSpot(xMm: number, zMm: number): void {
    // The whole place stays in view, seen from the spot's side: the walls are cut by where the
    // camera now is, so what's between you and it is gone.
    const centre = bounds.getCenter(new THREE.Vector3());
    const side = new THREE.Vector3(xMm * MM, 0, zMm * MM).sub(centre).setY(0);
    if (side.lengthSq() < 0.25) return;
    const offset = camera.position.clone().sub(controls.target);
    const height = offset.y;
    const across = Math.hypot(offset.x, offset.z);
    side.normalize().multiplyScalar(across);
    controls.target.setX(centre.x).setZ(centre.z);
    camera.position.set(centre.x + side.x, controls.target.y + height, centre.z + side.z);
    controls.update();
  }

  const markMaterial = new THREE.MeshBasicNodeMaterial({
    color: "#e53935",
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });
  let markRings: THREE.Mesh[] = [];
  function setMarks(marks: readonly SpotMark[]): void {
    for (const m of markRings) {
      scene.remove(m);
      m.geometry.dispose();
    }
    markRings = marks.map((k) => {
      const r = Math.max(0.3, k.radiusMm * MM);
      const ring = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.09, 48), markMaterial);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(
        k.xMm * MM,
        floorAt(k.xMm, k.zMm) + (k.aboveFloorMm ?? 0) * MM + 0.03,
        k.zMm * MM,
      );
      ring.renderOrder = 10;
      scene.add(ring);
      return ring;
    });
  }

  type Spot = Pick<PointerEvent, "clientX" | "clientY">;
  /** What's just beside a tap, when nothing is right under it. */
  function nearby<T>(e: Spot, at: (spot: Spot) => T | null): T | null {
    for (const [dx, dy] of TOUCH_AROUND) {
      const found = at({
        clientX: e.clientX + dx * TOUCH_REACH_PX,
        clientY: e.clientY + dy * TOUCH_REACH_PX,
      });
      if (found !== null) return found;
    }
    return null;
  }
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function ray(e: Spot): void {
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
  }
  function thingAt(e: Spot): string | null {
    ray(e);
    const roots = [...thingViews.values()].filter((v) => v.root.visible).map((v) => v.root);
    for (const hit of raycaster.intersectObjects(roots, true)) {
      if (!hit.object.visible) continue;
      let o: THREE.Object3D | null = hit.object;
      while (o && o.userData["objectId"] === undefined) o = o.parent;
      if (o) return o.userData["objectId"] as string;
    }
    return null;
  }

  interface Press {
    x: number;
    y: number;
    id: string | null;
    dragging: boolean;
    offset: THREE.Vector3;
    floorY: number;
    /** Where this thing may stand; built once per drag. */
    allowed: ((xMm: number, zMm: number, yawDeg: number) => boolean) | null;
  }
  let press: Press | null = null;
  let placementCheck: PlacementCheck | null = null;
  let rearranging: {
    grab(object: string): string | null;
    carried(object: string): readonly string[];
  } | null = null;
  const dropListeners: ((
    object: string,
    to: { xMm: number; zMm: number; yawDeg: number },
  ) => void)[] = [];
  /** What's picked up, how it's turned, and what rides on it (each as it was when picked up). */
  let moving: {
    id: string;
    yawDeg: number;
    fits: boolean;
    /** Let go and waiting on the place: not to be picked up again until it answers. */
    settled: boolean;
    from: { x: number; z: number; yawDeg: number };
    riders: { root: THREE.Object3D; x: number; z: number; rotation: number }[];
    allowed: ((xMm: number, zMm: number, yawDeg: number) => boolean) | null;
  } | null = null;

  /** Riders go where the thing's turn and shift take them; the ring goes with it. */
  function placeMoving(): void {
    if (!moving) return;
    const root = thingViews.get(moving.id)?.root;
    if (!root) return;
    root.rotation.y = (-moving.yawDeg * Math.PI) / 180;
    const turn = ((moving.yawDeg - moving.from.yawDeg) * Math.PI) / 180;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    for (const r of moving.riders) {
      const dx = r.x - moving.from.x;
      const dz = r.z - moving.from.z;
      r.root.position.x = root.position.x + dx * cos - dz * sin;
      r.root.position.z = root.position.z + dx * sin + dz * cos;
      r.root.rotation.y = r.rotation - turn;
    }
    if (selectionRing) {
      selectionRing.position.set(root.position.x, root.position.y + 0.015, root.position.z);
    }
    for (const c of movableGroup.children) {
      if (c.userData["thing"] !== moving.id) continue;
      c.position.x = root.position.x;
      c.position.z = root.position.z;
      c.rotation.y = root.rotation.y;
    }
    holdMaterial.color.setHex(moving.fits ? 0x2f6fde : 0xe5484d);
  }

  function setMoving(object: string | null, carried: readonly string[] = []): void {
    const root = object ? thingViews.get(object)?.root : undefined;
    if (!object || !root) {
      moving = null;
      setSelected(null);
      holdMaterial.color.setHex(0x2f6fde);
      return;
    }
    const o = loaded?.objects.find((x) => x.id === object);
    const yawDeg = Math.round(o?.transform.yawDeg ?? 0);
    moving = {
      id: object,
      yawDeg,
      fits: true,
      settled: false,
      from: { x: root.position.x, z: root.position.z, yawDeg },
      riders: carried.flatMap((id) => {
        const r = thingViews.get(id)?.root;
        return r ? [{ root: r, x: r.position.x, z: r.position.z, rotation: r.rotation.y }] : [];
      }),
      allowed: placementCheck ? placementCheck(object) : null,
    };
    setSelected(object);
  }
  let hovered: string | null = null;
  let hoverEvent: PointerEvent | null = null;
  let hoverQueued = false;
  const hoverListeners: ((id: string | null) => void)[] = [];
  const personListeners: ((slot: number) => void)[] = [];
  const groundListeners: ((x: number, z: number) => void)[] = [];

  function personAt(e: Spot): number | null {
    ray(e);
    for (const hit of raycaster.intersectObjects(peopleGroup.children, true)) {
      let o: THREE.Object3D | null = hit.object;
      while (o && o.userData["slot"] === undefined) o = o.parent;
      if (o?.visible) return o.userData["slot"] as number;
    }
    return null;
  }

  function groundAt(e: PointerEvent): { x: number; z: number } | null {
    ray(e);
    const hit = raycaster.intersectObjects(world.children, false)[0];
    if (!hit) return null;
    return { x: Math.round(hit.point.x * 1000), z: Math.round(hit.point.z * 1000) };
  }

  // Fingers down: a second one makes this a pinch, which must end in neither a tap nor a drag.
  const fingers = new Set<number>();
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    fingers.add(e.pointerId);
    if (fingers.size > 1) {
      press = null;
      controls.enabled = true;
      return;
    }
    if (moving?.settled) return;
    if (rearranging && !moving) {
      const touched = thingAt(e) ?? (e.pointerType === "touch" ? nearby(e, thingAt) : null);
      const grabbed = touched ? rearranging.grab(touched) : null;
      if (grabbed) setMoving(grabbed, rearranging.carried(grabbed));
    }
    if (moving) ray(e);
    const id = moving ? moving.id : thingAt(e);
    const root = id ? thingViews.get(id)?.root : undefined;
    let offset = new THREE.Vector3();
    const floorY = root?.position.y ?? 0;
    if (root && moving) {
      // Placing a thing must not also orbit the camera.
      controls.enabled = false;
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY);
      const hit = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      if (hit) offset = hit.sub(root.position);
    }
    const allowed = moving?.allowed ?? null;
    press = { x: e.clientX, y: e.clientY, id, dragging: false, offset, floorY, allowed };
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!press && e.target === canvas && e.pointerType !== "touch") {
      hoverEvent = e;
      if (!hoverQueued) {
        hoverQueued = true;
        requestAnimationFrame(() => {
          hoverQueued = false;
          const id = hoverEvent ? thingAt(hoverEvent) : null;
          if (id !== hovered) {
            hovered = id;
            canvas.style.cursor = id ? "pointer" : "";
            for (const l of hoverListeners) l(id);
          }
        });
      }
    }
    if (!press?.id || !moving) return;
    if (
      !press.dragging &&
      Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD_PX
    ) {
      return;
    }
    press.dragging = true;
    ray(e);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -press.floorY);
    const hit = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    const root = thingViews.get(press.id)?.root;
    if (!hit || !root) return;
    const p = hit.sub(press.offset);
    const want = {
      x: Math.round((p.x * 1000) / SNAP_MM) * SNAP_MM,
      z: Math.round((p.z * 1000) / SNAP_MM) * SNAP_MM,
    };
    // It follows the finger wherever it goes, past whatever's in the way: things filmed
    // overlapping must be able to get out, and only where it's put down has to work. The ring
    // says so as it goes.
    const { x, z } = want;
    const yawDeg = moving.yawDeg;
    const ok = (ax: number, az: number) => !press?.allowed || press.allowed(ax, az, yawDeg);
    root.position.x = x / 1000;
    root.position.z = z / 1000;
    moving.fits = ok(x, z);
    placeMoving();
  };
  const onPointerCancel = (e: PointerEvent) => {
    fingers.delete(e.pointerId);
    press = null;
    controls.enabled = true;
    if (moving) placeMoving();
  };
  const onPointerUp = (e: PointerEvent) => {
    fingers.delete(e.pointerId);
    const p = press;
    press = null;
    controls.enabled = true;
    if (moving && !moving.settled) {
      placeMoving();
      if (!p?.dragging) {
        // A tap, not a move: it's only been pointed at.
        const tapped = moving.id;
        setMoving(null);
        for (const l of selectListeners) l(tapped);
        return;
      }
      const root = thingViews.get(moving.id)?.root;
      if (!root) return;
      moving.settled = true;
      const to = {
        xMm: Math.round(root.position.x * 1000),
        zMm: Math.round(root.position.z * 1000),
        yawDeg: moving.yawDeg,
      };
      for (const l of dropListeners) l(moving.id, to);
      return;
    }
    if (!p) return;
    const touch = e.pointerType === "touch";
    const clicked =
      !p.dragging &&
      Math.hypot(e.clientX - p.x, e.clientY - p.y) < (touch ? TOUCH_TAP_PX : DRAG_THRESHOLD_PX);
    if (clicked) {
      const slot = p.id ? null : (personAt(e) ?? (touch ? nearby(e, personAt) : null));
      if (slot !== null) {
        for (const l of personListeners) l(slot);
        return;
      }
      const id = p.id ?? (touch ? nearby(e, thingAt) : null);
      for (const l of selectListeners) l(id);
      if (!id) {
        const g = groundAt(e);
        if (g) {
          marker.position.set(g.x * MM, floorAt(g.x, g.z) + 0.02, g.z * MM);
          marker.scale.setScalar(1);
          markerMaterial.opacity = 0.95;
          for (const l of groundListeners) l(g.x, g.z);
        }
      }
    }
  };
  canvas.addEventListener("pointerdown", onPointerDown, { capture: true });
  globalThis.addEventListener("pointermove", onPointerMove);
  globalThis.addEventListener("pointerup", onPointerUp);
  globalThis.addEventListener("pointercancel", onPointerCancel);

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  let frameCount = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    if (governor.frame(now - lastDraw)) {
      const look = lookNow();
      // Once off it stays off, even if the governor steps back to a level that has it.
      if (!look.ambientOcclusion && pipeline) {
        pipeline.dispose();
        pipeline = null;
      }
      renderer.setPixelRatio(pixelRatioFor(look));
      resize();
    }
    frameCount++;
    sun.shadow.autoUpdate = false;
    sun.shadow.needsUpdate = frameCount % lookNow().shadowEveryFrames === 0;
    const dt = Math.min(0.1, (now - lastDraw) / 1000);
    lastDraw = now;
    if (markerMaterial.opacity > 0) {
      markerMaterial.opacity = Math.max(0, markerMaterial.opacity - dt * 1.2);
      marker.scale.multiplyScalar(1 + dt * 0.8);
    }
    const followed = following === null ? null : people[following];
    // A finger on the screen has the camera: following it and them at once is what feels like drag.
    if (followed?.person.root.visible && fingers.size === 0) {
      // Glide the view along with them, keeping the same angle and distance; aim at their
      // chest so they stand in the lower middle of the screen, clear of the HUD's top row.
      const target = followed.person.root.position
        .clone()
        .setY(followed.person.root.position.y + FOLLOW_AIM_M);
      const step = target
        .clone()
        .sub(controls.target)
        .multiplyScalar(1 - Math.exp(-dt * FOLLOW_PER_S));
      controls.target.add(step);
      camera.position.add(step);
    }
    if (Math.abs(turnLeft) > 1e-4) {
      const step = turnLeft * Math.min(1, dt * 6);
      turnLeft -= step;
      const offset = camera.position.clone().sub(controls.target);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), step);
      camera.position.copy(controls.target).add(offset);
    }
    controls.update();
    updatePeople(dt);
    {
      const who = following === null ? null : people[following];
      const moved =
        who !== null &&
        who !== undefined &&
        Math.hypot(
          who.person.root.position.x - cutAround.x,
          who.person.root.position.z - cutAround.z,
        ) > RECUT_AFTER_M;
      if (loaded && (cameraSector() !== cutSector || moved)) {
        cutSector = cameraSector();
        buildWalls(loaded);
      }
    }
    if (pipeline) pipeline.render();
    else renderer.render(scene, camera);
  });

  return {
    backend,
    loadScene,
    setPeople,
    setYou: (slot) => {
      you = slot;
    },
    setTime,
    follow(slot) {
      following = slot;
      if (loaded) buildWalls(loaded);
      const p = slot === null ? null : people[slot];
      if (p) {
        // Over the shoulder: close in, keeping the direction we look from, 8 m away and
        // about 35 degrees down, so the place reads as a place and not a floor plan.
        const flat = camera.position.clone().sub(controls.target).setY(0);
        if (flat.lengthSq() < 1e-6) flat.set(0, 0, 1);
        const elevation = 0.62;
        const offset = flat
          .normalize()
          .multiplyScalar(Math.cos(elevation))
          .setY(Math.sin(elevation))
          // Held upright a screen sees a sliver across: stand further back, or there's no place.
          .multiplyScalar(8 * Math.max(1, camera.aspect ** -0.75));
        const aim = p.person.root.position.clone();
        aim.y += FOLLOW_AIM_M;
        controls.target.copy(aim);
        camera.position.copy(aim).add(offset);
      } else {
        frame();
      }
      controls.update();
    },
    setSurroundings: (colour) => {
      groundMat.color.set(colour);
    },
    setMovable,
    setFooting(fits) {
      footing = fits;
    },
    steer(slot, way) {
      steerSlot = slot;
      steering = way;
    },
    speed() {
      return {
        fps: governor.fps,
        level: governor.level,
        drawCalls: renderer.info.render.drawCalls,
        triangles: renderer.info.render.triangles,
        you: (() => {
          const root = following === null ? null : people[following]?.person.root;
          return root
            ? { xMm: Math.round(root.position.x * 1000), zMm: Math.round(root.position.z * 1000) }
            : null;
        })(),
      };
    },
    setRearranging(rules) {
      rearranging = rules;
      if (!rules) setMoving(null);
    },
    placeThings(objects) {
      setMoving(null);
      const byId = new Map(objects.map((o) => [o.id as string, o]));
      if (loaded) {
        const was = loaded;
        loaded = { ...was, objects: was.objects.map((o) => byId.get(o.id) ?? o) };
      }
      for (const o of objects) {
        const root = thingViews.get(o.id)?.root;
        if (!root) continue;
        const [x = 0, above = 0, z = 0] = o.transform.position;
        root.position.set(x * MM, floorAt(x, z) + above * MM, z * MM);
        root.rotation.y = (-o.transform.yawDeg * Math.PI) / 180;
      }
    },
    onDrop: (l) => {
      dropListeners.push(l);
    },
    setAgents,
    setState: applyState,
    setPlacementCheck: (check) => {
      placementCheck = check;
    },
    setSelected,
    setMarks,
    showSpot,
    rotate,
    onSelect: (l) => {
      selectListeners.push(l);
    },
    onHover: (l) => {
      hoverListeners.push(l);
    },
    onPerson: (l) => {
      personListeners.push(l);
    },
    onGround: (l) => {
      groundListeners.push(l);
    },
    whereIs(slot) {
      const p = people[slot];
      if (!p) return null;
      const r = p.person.root.position;
      return { x: Math.round(r.x * 1000), z: Math.round(r.z * 1000) };
    },
    facing() {
      const v = controls.target.clone().sub(camera.position).setY(0);
      if (v.lengthSq() < 1e-8) return { x: 0, z: -1 };
      v.normalize();
      return { x: v.x, z: v.z };
    },
    screenOfPerson(slot) {
      const p = people[slot];
      if (!p?.person.root.visible) return null;
      // Over their head, wherever that is: someone lying down keeps their name close by.
      const above = poses[slot] === 2 ? 0.7 : poses[slot] === 1 ? 1.5 : 1.95;
      return toScreen(p.person.root.position.clone().add(new THREE.Vector3(0, above, 0)));
    },
    screenOfThing(id) {
      const view = thingViews.get(id);
      const o = loaded?.objects.find((x) => x.id === id);
      if (!view || !o) return null;
      return toScreen(
        view.root.position.clone().add(new THREE.Vector3(0, o.size.h * MM + 0.15, 0)),
      );
    },
    resize,
    dispose() {
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      controls.dispose();
      canvas.removeEventListener("pointerdown", onPointerDown, { capture: true });
      globalThis.removeEventListener("pointermove", onPointerMove);
      globalThis.removeEventListener("pointerup", onPointerUp);
      globalThis.removeEventListener("pointercancel", onPointerCancel);
      clearGroup(world);
      clearGroup(thingsGroup);
      for (const p of people) p?.person.dispose();
      youRing.geometry.dispose();
      marker.geometry.dispose();
      markerMaterial.dispose();
      ground.geometry.dispose();
      groundMat.dispose();
      pipeline?.dispose();
      environment.dispose();
      pmrem.dispose();
      for (const m of materials.values()) m.dispose();
      for (const m of glowMaterials.values()) m.dispose();
      for (const m of surfaceMaterials.values()) m.dispose();
      renderer.dispose();
    },
  };
}

/** Merge box pieces into one geometry (one draw call for all walls). */
function mergeBoxes(pieces: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (const piece of pieces) {
    const g = piece.index ? piece.toNonIndexed() : piece;
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    for (let i = 0; i < p.count; i++) {
      const [x, y, z] = [p.getX(i), p.getY(i), p.getZ(i)];
      const [nx, ny, nz] = [n.getX(i), n.getY(i), n.getZ(i)];
      positions.push(x, y, z);
      normals.push(nx, ny, nz);
      // Planar texture coordinates in metres, along whichever face this is.
      if (Math.abs(ny) > 0.5) uvs.push(x, z);
      else if (Math.abs(nx) > Math.abs(nz)) uvs.push(z, y);
      else uvs.push(x, y);
    }
    if (g !== piece) g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  out.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  return out;
}

/** One var condition, as the sim evaluates it. */
function compare(value: number, op: "eq" | "ne" | "gte" | "lte", target: number): boolean {
  switch (op) {
    case "eq":
      return value === target;
    case "ne":
      return value !== target;
    case "gte":
      return value >= target;
    case "lte":
      return value <= target;
    default:
      return false;
  }
}
