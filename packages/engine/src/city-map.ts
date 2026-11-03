/**
 * The city map: a stylised, toy-like view of a whole city as its spec describes it. Land,
 * districts, water and roads are flat coloured shapes; each place is a block in its own colour.
 * Pins and labels are not drawn here: the game puts DOM elements (emoji, names) where
 * `screenOf` says, so text stays crisp and accessible and never passes through a canvas.
 *
 * Nothing here knows what any place is. Draw calls stay few: one mesh per district and water
 * body, all roads merged, every building's look merged, each kind of scenery instanced.
 * What buildings and scenery look like is the city model's design: a library model it chose
 *, fitted to the building's block, else its own primitives. Library scenery is
 * instanced per mesh, so a hundred palms cost a handful of draw calls.
 */
import {
  type CitySpec,
  type CityViews,
  dayPhase,
  type Look,
  mapBlock,
  moversOf,
  placesOf,
  viewsOf,
} from "@aye/schema";
import { MapControls } from "three/addons/controls/MapControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import * as THREE from "three/webgpu";
import { fitInto, getLibrary, type Library } from "./library.ts";
import { glowing, mergeSolids, type PlacedSolid, placeSolids, vertexColoured } from "./solids.ts";
import { startRenderer } from "./start-renderer.ts";

/** The footprint of a building lining a street, metres (chunky, like the places). */
const LOT_M = 38;
/** Scenery is drawn bigger than life too, in proportion with the buildings. */
const SCENERY_SCALE = 2;
/** Footprints for picking live on their own layer: hit by clicks, never drawn. */
const PICK_LAYER = 1;
/** A fingertip wobbles: this far is still a tap. */
const TOUCH_TAP_PX = 12;

/** How far from its centre the close view of the map shows places, in metres. */
const CLOSE_SEES_M = 700;
/** The close view never pulls back further than this, however far apart places are. */
const CLOSE_MAX_ZOOM_OUT = 5;

export interface CityMap {
  readonly backend: "webgpu" | "webgl2";
  /**
   * Draw a city. A real city passes its road network (drawn at true scale in place
   * of the sketched roads, the map as big as the city) and what covers its ground.
   */
  load(city: CitySpec, network?: MapNetwork | null, land?: MapLand | null): void;
  setSelected(placeKey: string | null): void;
  /** Click on a place's block (or on nothing: null). */
  onSelect(listener: (placeKey: string | null) => void): void;
  /** Where a map point (metres) is on the canvas, in CSS pixels, or null if off-screen. */
  screenOf(x: number, z: number, heightM?: number): { x: number; y: number } | null;
  /** The drawn top of a place's block, for its pin. */
  pinOf(placeKey: string): { x: number; y: number } | null;
  /** Light for this minute of the city's day: dimmer at night, when lit things glow. */
  setTime(minuteOfDay: number): void;
  /**
   * City life: where everyone is (metres), which of the city's movers they travel
   * by (`RESTING`: not out, not drawn) and which way they're heading, and each road
   * segment's load over capacity (permille), or null to hide.
   */
  setLife(
    life: {
      xz: Float32Array;
      mover: Uint8Array;
      dir: Float32Array;
      roads: {
        x: Int32Array;
        z: Int32Array;
        a: Int32Array;
        b: Int32Array;
        loadPermille: Uint16Array;
      };
    } | null,
  ): void;
  /**
   * A planner's scenario over a real city's roads, by network link: closed ones,
   * ones with changed lanes, the one being looked at, and how much fuller (positive) or
   * emptier each edge got by day, permille of what it holds. Null hides it.
   */
  setPlan(
    plan: {
      closed: readonly number[];
      edited: readonly number[];
      selected: number | null;
      change: {
        x: Int32Array;
        z: Int32Array;
        a: Int32Array;
        b: Int32Array;
        changePermille: Int16Array;
      } | null;
    } | null,
  ): void;
  /** The real road link under a point on the canvas (CSS pixels from its corner), or null. */
  roadAt(x: number, y: number, finger?: boolean): number | null;
  /** Where on the ground a point on the canvas is (metres on the map), or null (the sky). */
  groundAt(x: number, y: number): [number, number] | null;
  /** Fly the camera to look at a place; `close` also comes down to street level. */
  focus(placeKey: string, opts?: { close?: boolean }): void;
  resize(): void;
  dispose(): void;
}

export async function createCityMap(
  canvas: HTMLCanvasElement,
  opts: { library?: Library | null } = {},
): Promise<CityMap> {
  const library = opts.library === undefined ? getLibrary() : opts.library;
  /** Bumped per load, so library models for an older city are dropped. */
  let generation = 0;
  const renderer = await startRenderer(canvas);
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? "webgpu"
    : "webgl2";
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  // A generated studio environment (no files), so textured library buildings read as solid.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = environment;
  scene.environmentIntensity = 0.4;
  const camera = new THREE.PerspectiveCamera(32, 1, 10, 30_000);
  const controls = new MapControls(camera, canvas);
  controls.enableDamping = true;
  controls.minDistance = 400;
  controls.maxDistance = 9_000;
  controls.maxPolarAngle = 1.1;
  controls.minPolarAngle = 0.35;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x9c8f7a, 2.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun, sun.target);

  const content = new THREE.Group();
  scene.add(content);
  const disposables: { dispose(): void }[] = [];
  const mat = (colour: string) => {
    const m = new THREE.MeshStandardNodeMaterial({ color: colour, roughness: 0.9 });
    disposables.push(m);
    return m;
  };

  let city: CitySpec | null = null;
  /** A real city's links as drawn (index = link), for picking and the plan. */
  let links: { points: [number, number][]; widthM: number; cls: number }[] = [];
  const plan = new THREE.Group();
  scene.add(plan);
  const planDisposables: { dispose(): void }[] = [];
  let blocks: THREE.InstancedMesh | null = null;
  let selected: string | null = null;
  const selectListeners: ((key: string | null) => void)[] = [];
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1, 1.12, 64),
    new THREE.MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;
  scene.add(ring);

  function flat(points: readonly (readonly [number, number])[], y: number, colour: string) {
    const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, y, 0);
    disposables.push(geometry);
    // Ground layers (land, districts, water) are drawn bottom-up in order and write no depth,
    // so they never fight each other however far the camera is; what stands on them still
    // depth-tests as usual.
    const material = mat(colour);
    material.depthWrite = false;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = -10 + y;
    mesh.receiveShadow = true;
    content.add(mesh);
  }

  function clear(): void {
    for (const child of [...content.children]) content.remove(child);
    for (const d of disposables.splice(0)) d.dispose();
    blocks = null;
  }

  /**
   * A real city's ground cover, one merged mesh per kind, over the districts, in the colours
   * its theme gives built-up, industrial and green ground; water covers them.
   */
  function cover(land: MapLand, c: CitySpec["theme"]["colours"]): void {
    // The city's own colours for its ground, laid lightly over its districts; water covers.
    const looks = [
      { colour: c.built, opacity: 0.35, y: 1.2 },
      { colour: c.industrial, opacity: 0.4, y: 1.4 },
      { colour: c.green, opacity: 0.45, y: 1.6 },
      { colour: c.water, opacity: 1, y: 2 },
    ];
    const tris: number[][] = looks.map(() => []);
    const ring = (r: number) => {
      const out: THREE.Vector2[] = [];
      for (let k = land.ringAt[r] as number; k < (land.ringAt[r + 1] as number); k++) {
        out.push(new THREE.Vector2(land.points[k * 2] as number, land.points[k * 2 + 1] as number));
      }
      return out;
    };
    for (let r = 0; r < land.kinds.length; ) {
      const kind = land.kinds[r] as number;
      const contour = ring(r);
      const holes: THREE.Vector2[][] = [];
      for (r++; r < land.kinds.length && land.holes[r] === 1; r++) holes.push(ring(r));
      const look = looks[kind];
      const out = tris[kind];
      if (!look || !out) continue;
      const all = [contour, ...holes].flat();
      for (const face of THREE.ShapeUtils.triangulateShape(contour, holes)) {
        for (const v of face) {
          const p = all[v] as THREE.Vector2;
          out.push(p.x, look.y, p.y);
        }
      }
    }
    looks.forEach((look, kind) => {
      const positions = tris[kind] as number[];
      if (positions.length === 0) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      const normals = new Float32Array(positions.length);
      for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
      geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
      disposables.push(geometry);
      const material = mat(look.colour);
      material.side = THREE.DoubleSide;
      material.depthWrite = false;
      if (look.opacity < 1) {
        material.transparent = true;
        material.opacity = look.opacity;
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = -10 + look.y;
      mesh.receiveShadow = true;
      content.add(mesh);
    });
  }

  /** The extent the camera was last framed for (it frames a city once). */
  let framed: string | null = null;

  function load(
    next: CitySpec,
    network: MapNetwork | null = null,
    land: MapLand | null = null,
  ): void {
    clear();
    city = next;
    const at = ++generation;
    const c = next.theme.colours;
    const v = viewsOf(next);
    const [sizeX, sizeZ] = next.real ? next.real.extentM : [4_000, 4_000];
    const size = Math.max(sizeX, sizeZ);
    // Zooming out far enough to see the whole city, and its shadows as far as you can see.
    controls.maxDistance = Math.max(9_000, size * 1.6);
    camera.far = Math.max(30_000, size * 4);
    // A depth range that suits the map's size (ground layers don't rely on it).
    camera.near = Math.max(10, size / 2000);
    // Shadows only where the shadow map is fine enough to draw them (a city tens of km
    // across would get coarse stripes, not shadows).
    sun.castShadow = size <= 8_000;
    camera.updateProjectionMatrix();
    flat(
      [
        [-400, -400],
        [sizeX + 400, -400],
        [sizeX + 400, sizeZ + 400],
        [-400, sizeZ + 400],
      ],
      0,
      c.land,
    );
    for (const d of v.districts) flat(d.polygon, 1, d.colour);
    for (const w of v.water) flat(w.polygon, 2, c.water);
    if (land) cover(land, c);

    // Roads: one merged geometry of flat strips (a real city's from its network: every link
    // along its true shape, as wide as its lanes).
    links = network ? networkRoads(network) : [];
    const merged = stripGeometry(network ? links.filter((l) => l.cls <= LAST_ROAD) : v.lines, 3);
    // Ferry routes and railways in the colour of the city's own kind that runs on them.
    const lineColour = (way: string) => v.movers.find((m) => m.way === way)?.colour ?? c.ink;
    for (const [cls, colour] of [
      [FERRY, lineColour("water")],
      [RAIL, lineColour("rail")],
    ] as const) {
      const lines = stripGeometry(
        links.filter((l) => l.cls === cls),
        3.5,
      );
      if (!lines) continue;
      disposables.push(lines);
      const material = mat(colour);
      material.depthWrite = false;
      const mesh = new THREE.Mesh(lines, material);
      mesh.renderOrder = -6;
      content.add(mesh);
    }
    if (merged) {
      disposables.push(merged);
      const roads = new THREE.Mesh(merged, mat(c.road));
      roads.receiveShadow = true;
      content.add(roads);
    }

    // Streets lined with the buildings each district's model chose: lots along both sides of
    // every road, off the water, clear of other roads and of the places themselves.
    // (A real city's streets are its own; lining tens of thousands of links isn't for now.)
    if (library && !next.real) lineStreets(v, at);

    // Places: every building's look merged into one mesh. Their footprints, as invisible
    // instanced boxes on their own layer, are what clicks hit.
    const buildings: (PlacedSolid & { owner: string })[] = [];
    for (const p of v.places) {
      const [w, h, d] = mapBlock(p);
      const asset = p.look?.asset;
      if (asset && library) {
        // A library building, fitted to the block; its primitives stand in until it loads.
        const stand = new THREE.Group();
        content.add(stand);
        void library.thing(asset).then((model) => {
          if (!model || at !== generation) return;
          const fitted = fitInto(model, w * 0.92, h, d * 0.92);
          fitted.position.set(p.at[0], 3, p.at[1]);
          stand.add(fitted);
          hidden.add(p.key);
          rebuildTown();
        });
      }
      const solids =
        p.look && p.look.solids.length > 0
          ? placeSolids(p.look.solids, w, h, d)
          : [
              {
                primitive: "box" as const,
                position: [0, h / 2, 0] as [number, number, number],
                scale: [w, h, d] as [number, number, number],
                rotateDeg: [0, 0, 0] as [number, number, number],
                colour: p.colour,
              },
            ];
      for (const s of solids) {
        buildings.push({
          ...s,
          owner: p.key,
          position: [s.position[0] + p.at[0], s.position[1] + 3, s.position[2] + p.at[1]],
        });
      }
    }
    // Primitive buildings, merged; rebuilt without those a library model now draws.
    const hidden = new Set<string>();
    const town = new THREE.Group();
    content.add(town);
    const buildingMat = vertexColoured(0.75);
    const glowMat = glowing();
    disposables.push(buildingMat, glowMat);
    const townGeometries: THREE.BufferGeometry[] = [];
    const rebuildTown = () => {
      town.clear();
      for (const g of townGeometries.splice(0)) g.dispose();
      const shown = buildings.filter((b) => !hidden.has(b.owner));
      const lit = shown.filter((b) => !b.glow);
      const lights = shown.filter((b) => b.glow);
      if (lit.length > 0) {
        const merged = mergeSolids(lit, 0.75);
        townGeometries.push(merged);
        const mesh = new THREE.Mesh(merged, buildingMat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        town.add(mesh);
      }
      if (lights.length > 0) {
        const glowGeometry = mergeSolids(lights, 0.75);
        townGeometries.push(glowGeometry);
        town.add(new THREE.Mesh(glowGeometry, glowMat));
      }
    };
    disposables.push({
      dispose: () => {
        for (const g of townGeometries.splice(0)) g.dispose();
      },
    });
    rebuildTown();

    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    disposables.push(box);
    const pickMat = new THREE.MeshBasicNodeMaterial();
    disposables.push(pickMat);
    blocks = new THREE.InstancedMesh(box, pickMat, v.places.length);
    blocks.layers.set(PICK_LAYER);
    const m = new THREE.Matrix4();
    v.places.forEach((p, i) => {
      m.compose(
        new THREE.Vector3(p.at[0], 3, p.at[1]),
        new THREE.Quaternion(),
        new THREE.Vector3(...mapBlock(p)),
      );
      blocks?.setMatrixAt(i, m);
    });
    content.add(blocks);

    // Props: each item's kind's look as one geometry, instanced at every spot it stands.
    v.props.forEach((sc, k) => {
      if (sc.spots.length === 0) return;
      const [w, h, d] = sc.look.sizeM.map((x) => x * SCENERY_SCALE) as [number, number, number];
      const turnOf = (i: number) => (((i * 2654435761 + k * 40503) >>> 0) % 360) * (Math.PI / 180);
      const asset = sc.look.asset;
      if (asset && library) {
        // A library model: one instanced mesh per part of it, at every spot.
        void library.thing(asset).then((model) => {
          if (!model || at !== generation) return;
          const fitted = fitInto(model, w, h, d);
          fitted.updateMatrixWorld(true);
          const place = new THREE.Matrix4();
          fitted.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            const props = new THREE.InstancedMesh(mesh.geometry, mesh.material, sc.spots.length);
            props.castShadow = true;
            props.receiveShadow = true;
            sc.spots.forEach(([x, z], i) => {
              place.compose(
                new THREE.Vector3(x, 3, z),
                new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), turnOf(i)),
                new THREE.Vector3(1, 1, 1),
              );
              props.setMatrixAt(i, place.clone().multiply(mesh.matrixWorld));
            });
            content.add(props);
          });
        });
        return;
      }
      const placed = placeSolids(sc.look.solids, w, h, d);
      const parts = [
        { solids: placed.filter((x) => !x.glow), material: vertexColoured(0.8), shadows: true },
        { solids: placed.filter((x) => x.glow), material: glowing(), shadows: false },
      ];
      for (const part of parts) {
        disposables.push(part.material);
        if (part.solids.length === 0) continue;
        const geometry = mergeSolids(part.solids, 0.5);
        disposables.push(geometry);
        const props = new THREE.InstancedMesh(geometry, part.material, sc.spots.length);
        props.castShadow = part.shadows;
        props.receiveShadow = part.shadows;
        sc.spots.forEach(([x, z], i) => {
          m.compose(
            new THREE.Vector3(x, 3, z),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), turnOf(i)),
            new THREE.Vector3(1, 1, 1),
          );
          props.setMatrixAt(i, m);
        });
        content.add(props);
      }
    });

    // Look across the city from the south, a little from above, like a game board: once per
    // city, not on every reload (roads and land arriving, the city's news changing), which
    // would yank the view from wherever the player is looking.
    const frame = `${sizeX}x${sizeZ}`;
    if (framed !== frame) {
      framed = frame;
      flight = null;
      controls.target.set(sizeX / 2, 0, sizeZ / 2);
      camera.position.set(sizeX / 2 + size * 0.15, size * 0.9, sizeZ / 2 + size * 0.85);
      controls.update();
    }
    sun.position.set(size * 0.2, Math.max(4_000, size), size * 0.9);
    sun.target.position.set(sizeX / 2, 0, sizeZ / 2);
    const cam = sun.shadow.camera;
    cam.left = -size * 0.75;
    cam.right = size * 0.75;
    cam.top = size * 0.75;
    cam.bottom = -size * 0.75;
    cam.near = 100;
    cam.far = Math.max(12_000, size * 3);
    cam.updateProjectionMatrix();
    setSelected(selected);
  }

  /** Line every road with ordinary buildings from its district's fill (instanced per mesh). */
  function lineStreets(next: CityViews, at: number): void {
    const blocks = next.places.map((p) => {
      const [w, , d] = mapBlock(p);
      return { x: p.at[0], z: p.at[1], r: Math.hypot(w, d) / 2 + 45 };
    });
    const segments = next.lines.flatMap((r) =>
      r.points.slice(1).map((b, i) => ({ a: r.points[i] as [number, number], b, w: r.widthM })),
    );
    const nearRoad = (x: number, z: number, clear: number) =>
      segments.some(({ a, b, w }) => {
        const [ax, az] = a;
        const [bx, bz] = b;
        const len2 = (bx - ax) ** 2 + (bz - az) ** 2 || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / len2));
        return Math.hypot(x - (ax + t * (bx - ax)), z - (az + t * (bz - az))) < w / 2 + clear;
      });
    const lots = new Map<string, { x: number; z: number; yaw: number; tint: THREE.Color }[]>();
    const taken: [number, number][] = [];
    let n = 0;
    for (const { a, b, w } of segments) {
      const [ax, az] = a;
      const [bx, bz] = b;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1) continue;
      const ux = (bx - ax) / len;
      const uz = (bz - az) / len;
      for (let t = LOT_M; t < len - LOT_M; t += LOT_M + 14) {
        for (const [side, row] of [
          [-1, 0],
          [1, 0],
          [-1, 1],
          [1, 1],
        ] as const) {
          const off = w / 2 + LOT_M / 2 + 10 + row * (LOT_M + 16);
          const x = ax + ux * t - uz * off * side;
          const z = az + uz * t + ux * off * side;
          n++;
          if (x < 20 || z < 20 || x > 3_980 || z > 3_980) continue;
          if (next.water.some((wt) => inside(x, z, wt.polygon))) continue;
          if (blocks.some((bk) => Math.hypot(bk.x - x, bk.z - z) < bk.r)) continue;
          if (taken.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < LOT_M + 8)) continue;
          if (nearRoad(x, z, LOT_M / 2 + 4)) continue;
          const district = next.districts.find((d) => inside(x, z, d.polygon));
          if (!district || district.fill.length === 0) continue;
          const asset = district.fill[(n * 2654435761) % district.fill.length] as string;
          taken.push([x, z]);
          // Face the road: front (+z) towards it.
          const yaw = Math.atan2(uz * side, -ux * side);
          // Painted buildings: a light tint of the district's colour, varied per lot.
          const shade = ((n * 40503) % 100) / 100;
          const tint = new THREE.Color(district.colour).lerp(
            new THREE.Color("#ffffff"),
            0.6 + shade * 0.3,
          );
          const list = lots.get(asset) ?? [];
          list.push({ x, z, yaw, tint });
          lots.set(asset, list);
        }
      }
    }
    for (const [asset, spots] of lots) {
      const entry = library?.catalog.things.find((t) => t.id === asset);
      if (!entry || !library) continue;
      // Drawn chunky like the places (mapBlock), within a lot.
      const [rw, rh, rd] = entry.sizeMm.map((v) => (v / 1000) * 2.4) as [number, number, number];
      // Chunky like the places: a lot-sized footprint, its height near its proportions.
      const k = LOT_M / Math.max(rw, rd);
      void library.thing(asset).then((model) => {
        if (!model || at !== generation) return;
        const fitted = fitInto(model, rw * k, rh * k, rd * k);
        fitted.updateMatrixWorld(true);
        const place = new THREE.Matrix4();
        fitted.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const props = new THREE.InstancedMesh(mesh.geometry, mesh.material, spots.length);
          props.castShadow = true;
          props.receiveShadow = true;
          spots.forEach((p, i) => {
            place.compose(
              new THREE.Vector3(p.x, 3, p.z),
              new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw),
              new THREE.Vector3(1, 1, 1),
            );
            props.setMatrixAt(i, place.clone().multiply(mesh.matrixWorld));
            props.setColorAt(i, p.tint);
          });
          content.add(props);
        });
      });
    }
  }

  // ── City life: moving people and vehicles, and how loaded each road is ─────────────────
  const life = new THREE.Group();
  scene.add(life);
  const lifeGeo = { road: new THREE.BoxGeometry(1, 1, 1) };
  const lifeMat = {
    road: new THREE.MeshBasicNodeMaterial({ color: "#ffffff", transparent: true, opacity: 0.85 }),
  };
  /**
   * Each mover's travellers drawn as its kind's look: one instanced mesh per part
   * of it, rebuilt when the city changes. A library model is fitted to its box; primitives
   * stand in until it loads.
   */
  let travellers: { parts: { mesh: THREE.InstancedMesh; local: THREE.Matrix4 }[] }[] = [];
  let travellerGen = -1;
  let roadLoad: THREE.InstancedMesh | null = null;
  const lifeMatrix = new THREE.Matrix4();
  const lifePart = new THREE.Matrix4();
  const lifeColour = new THREE.Color();
  const lifeWarn = new THREE.Color();
  const lifeQuat = new THREE.Quaternion();
  const lifeUp = new THREE.Vector3(0, 1, 0);
  const lifePos = new THREE.Vector3();
  const lifeOne = new THREE.Vector3(1, 1, 1);
  /** Travellers are drawn bigger than life, like the map's buildings, so they read from above. */
  const TRAVELLER_SCALE = 6;
  const TRAVELLER_MIN_M = 8;

  const travellerDisposables: { dispose(): void }[] = [];
  function buildTravellers(next: CitySpec, capacity: number): void {
    for (const t of travellers) for (const p of t.parts) life.remove(p.mesh);
    for (const d of travellerDisposables.splice(0)) d.dispose();
    travellers = [];
    travellerGen = generation;
    const at = generation;
    const marker: Look = { sizeM: [1, 2, 1], solids: [] };
    for (const m of moversOf(next)) {
      const look = m.look ?? marker;
      const k = Math.max(TRAVELLER_SCALE, TRAVELLER_MIN_M / Math.max(1, look.sizeM[0]));
      const [l, h, w] = look.sizeM.map((v) => v * k) as [number, number, number];
      const entry = { parts: [] as { mesh: THREE.InstancedMesh; local: THREE.Matrix4 }[] };
      travellers.push(entry);
      const add = (
        geometry: THREE.BufferGeometry,
        material: THREE.Material,
        local: THREE.Matrix4,
      ) => {
        const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, capacity));
        travellerDisposables.push(mesh);
        mesh.frustumCulled = false;
        mesh.count = 0;
        life.add(mesh);
        entry.parts.push({ mesh, local });
      };
      const solids = placeSolids(look.solids, l, h, w);
      const plain = solids.filter((x) => !x.glow);
      const lit = solids.filter((x) => x.glow);
      const own = <T extends { dispose(): void }>(x: T) => {
        travellerDisposables.push(x);
        return x;
      };
      if (plain.length > 0) {
        add(own(mergeSolids(plain, 0.5)), own(vertexColoured(0.7)), new THREE.Matrix4());
      }
      if (lit.length > 0) add(own(mergeSolids(lit, 0.5)), own(glowing()), new THREE.Matrix4());
      if (solids.length === 0) {
        // Nothing drawn for it: a plain marker in its kind's colour.
        const g = new THREE.CapsuleGeometry(w / 2, Math.max(1, h - w), 4, 8).translate(0, h / 2, 0);
        add(
          own(g),
          own(new THREE.MeshStandardNodeMaterial({ color: m.colour })),
          new THREE.Matrix4(),
        );
      }
      const asset = look.asset;
      if (asset && library) {
        void library.thing(asset).then((model) => {
          if (!model || at !== generation) return;
          // Library models face +z; a mover's front is +x.
          const fitted = fitInto(model, w, h, l);
          fitted.rotation.y = Math.PI / 2;
          fitted.updateMatrixWorld(true);
          for (const p of entry.parts) life.remove(p.mesh);
          entry.parts = [];
          fitted.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh)
              add(mesh.geometry, mesh.material as THREE.Material, mesh.matrixWorld.clone());
          });
        });
      }
    }
  }

  function setPlan(next: Parameters<CityMap["setPlan"]>[0]): void {
    for (const child of [...plan.children]) plan.remove(child);
    for (const d of planDisposables.splice(0)) d.dispose();
    if (!next || !city) return;
    const c = city.theme.colours;
    const add = (geometry: THREE.BufferGeometry | null, colour: string, order: number) => {
      if (!geometry) return;
      const material = new THREE.MeshBasicNodeMaterial({ color: colour });
      material.depthWrite = false;
      planDisposables.push(geometry, material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = order;
      plan.add(mesh);
    };
    const pick = (ids: readonly number[], extraM: number) =>
      ids
        .map((l) => links[l])
        .filter((r): r is (typeof links)[number] => r !== undefined)
        .map((r) => ({ points: r.points, widthM: r.widthM + extraM }));
    const ch = next.change;
    if (ch) {
      // Fuller roads in the theme's bad colour, emptier in its good, wider the more they
      // changed; small changes are left out.
      const worse: { points: [number, number][]; widthM: number }[] = [];
      const better: { points: [number, number][]; widthM: number }[] = [];
      for (let e = 0; e < ch.a.length; e++) {
        const v = ch.changePermille[e] as number;
        if (Math.abs(v) < 30) continue;
        const a = ch.a[e] as number;
        const b = ch.b[e] as number;
        const road = links[e];
        const points: [number, number][] = road
          ? road.points
          : [
              [ch.x[a] as number, ch.z[a] as number],
              [ch.x[b] as number, ch.z[b] as number],
            ];
        (v > 0 ? worse : better).push({ points, widthM: 14 + Math.min(60, Math.abs(v) / 8) });
      }
      add(stripGeometry(better, 7), c.good, 20);
      add(stripGeometry(worse, 7), c.bad, 21);
    }
    add(stripGeometry(pick(next.edited, 24), 8), c.accent, 22);
    add(stripGeometry(pick(next.closed, 24), 9), c.ink, 23);
    if (next.selected !== null) add(stripGeometry(pick([next.selected], 40), 10), c.warn, 24);
  }

  function pointOnGround(px: number, py: number): THREE.Vector3 | null {
    const ndc = new THREE.Vector2(
      (px / (canvas.clientWidth || 1)) * 2 - 1,
      -(py / (canvas.clientHeight || 1)) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    return ray.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -3),
      new THREE.Vector3(),
    );
  }

  function groundAt(px: number, py: number): [number, number] | null {
    const hit = pointOnGround(px, py);
    return hit ? [hit.x, hit.z] : null;
  }

  function roadAt(px: number, py: number, finger = false): number | null {
    if (links.length === 0) return null;
    const hit = pointOnGround(px, py);
    if (!hit) return null;
    // Within a few pixels' worth of ground, however far out the camera is.
    // A finger hides what it taps, so it gets further.
    const reach = Math.max(25, camera.position.distanceTo(hit) * (finger ? 0.03 : 0.012));
    let best: number | null = null;
    let bestD = reach;
    links.forEach((r, l) => {
      if (r.cls > RAIL) return; // access walks aren't drawn, so aren't picked
      for (let i = 1; i < r.points.length; i++) {
        const [ax, az] = r.points[i - 1] as [number, number];
        const [bx, bz] = r.points[i] as [number, number];
        const dx = bx - ax;
        const dz = bz - az;
        const t = Math.max(
          0,
          Math.min(1, ((hit.x - ax) * dx + (hit.z - az) * dz) / (dx * dx + dz * dz || 1)),
        );
        const d = Math.hypot(ax + dx * t - hit.x, az + dz * t - hit.z) - r.widthM / 2;
        if (d < bestD) {
          bestD = d;
          best = l;
        }
      }
    });
    return best;
  }

  function setLife(next: Parameters<CityMap["setLife"]>[0]): void {
    life.visible = next !== null;
    if (!next || !city) return;
    const n = next.mover.length;
    if (
      travellerGen !== generation ||
      (travellers[0]?.parts[0]?.mesh.instanceMatrix.count ?? 0) < n
    ) {
      buildTravellers(city, n);
    }
    const ensure = (
      mesh: THREE.InstancedMesh | null,
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      count: number,
    ) => {
      if (mesh && mesh.instanceMatrix.count >= count) return mesh;
      if (mesh) {
        life.remove(mesh);
        mesh.dispose();
      }
      const m = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
      m.frustumCulled = false;
      life.add(m);
      return m;
    };
    const counts = new Array<number>(travellers.length).fill(0);
    for (let i = 0; i < n; i++) {
      const k = next.mover[i] as number;
      const t = travellers[k];
      if (!t) continue; // resting, or a mover the city no longer has
      const dx = next.dir[i * 2] as number;
      const dz = next.dir[i * 2 + 1] as number;
      lifeQuat.setFromAxisAngle(lifeUp, dx === 0 && dz === 0 ? 0 : -Math.atan2(dz, dx));
      lifePos.set(next.xz[i * 2] as number, 3, next.xz[i * 2 + 1] as number);
      lifeMatrix.compose(lifePos, lifeQuat, lifeOne);
      const c = counts[k] as number;
      for (const p of t.parts) {
        p.mesh.setMatrixAt(c, lifePart.multiplyMatrices(lifeMatrix, p.local));
      }
      counts[k] = c + 1;
    }
    travellers.forEach((t, k) => {
      for (const p of t.parts) {
        p.mesh.count = counts[k] as number;
        p.mesh.instanceMatrix.needsUpdate = true;
      }
    });
    const r = next.roads;
    roadLoad = ensure(roadLoad, lifeGeo.road, lifeMat.road, r.a.length);
    for (let e = 0; e < r.a.length; e++) {
      const ax = r.x[r.a[e] as number] as number;
      const az = r.z[r.a[e] as number] as number;
      const bx = r.x[r.b[e] as number] as number;
      const bz = r.z[r.b[e] as number] as number;
      const len = Math.hypot(bx - ax, bz - az);
      lifeMatrix.compose(
        new THREE.Vector3((ax + bx) / 2, 6, (az + bz) / 2),
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          -Math.atan2(bz - az, bx - ax),
        ),
        new THREE.Vector3(len, 1, 9),
      );
      roadLoad.setMatrixAt(e, lifeMatrix);
      const p = Math.min(1500, r.loadPermille[e] as number) / 1000;
      // How full, in the city's own colours: good, then warn, then bad.
      const cs = city.theme.colours;
      lifeColour.set(cs.good).lerp(lifeWarn.set(cs.warn), Math.min(1, p / 0.6));
      if (p > 0.6) lifeColour.lerp(lifeWarn.set(cs.bad), Math.min(1, (p - 0.6) / 0.6));
      roadLoad.setColorAt(e, lifeColour);
    }
    roadLoad.count = r.a.length;
    roadLoad.instanceMatrix.needsUpdate = true;
    if (roadLoad.instanceColor) roadLoad.instanceColor.needsUpdate = true;
  }

  function setSelected(key: string | null): void {
    selected = key;
    const p = (city ? placesOf(city) : []).find((x) => x.key === key);
    ring.visible = Boolean(p);
    if (!p) return;
    const [bw, , bd] = mapBlock(p);
    const r = Math.hypot(bw, bd) * 0.62;
    ring.scale.set(r, r, r);
    ring.position.set(p.at[0], 4, p.at[1]);
  }

  const v = new THREE.Vector3();
  function screenOf(x: number, z: number, heightM = 0) {
    v.set(x, heightM, z).project(camera);
    if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) return null;
    return {
      x: ((v.x + 1) / 2) * canvas.clientWidth,
      y: ((1 - v.y) / 2) * canvas.clientHeight,
    };
  }

  // Clicks (not drags) pick a block.
  const raycaster = new THREE.Raycaster();
  raycaster.layers.set(PICK_LAYER);
  let down: { x: number; y: number } | null = null;
  // Fingers on the map: a second one makes this a pinch, and no finger of a pinch is a tap.
  const fingers = new Set<number>();
  const onDown = (e: PointerEvent) => {
    fingers.add(e.pointerId);
    down = fingers.size > 1 ? null : { x: e.clientX, y: e.clientY };
  };
  const onCancel = (e: PointerEvent) => {
    fingers.delete(e.pointerId);
    down = null;
  };
  const onUp = (e: PointerEvent) => {
    fingers.delete(e.pointerId);
    // A fingertip wobbles more than a mouse.
    const reach = e.pointerType === "touch" ? TOUCH_TAP_PX : 5;
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > reach || !blocks || !city) {
      down = null;
      return;
    }
    down = null;
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    const hit = raycaster.intersectObject(blocks)[0];
    const key =
      hit?.instanceId !== undefined ? (placesOf(city)[hit.instanceId]?.key ?? null) : null;
    for (const l of selectListeners) l(key);
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);

  function resize(): void {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  let flight: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    camFrom: THREE.Vector3;
    /** Where the camera ends up relative to the target, if it should come closer. */
    offsetTo: THREE.Vector3 | null;
    offsetFrom: THREE.Vector3;
    t: number;
  } | null = null;
  renderer.setAnimationLoop(() => {
    if (flight) {
      flight.t = Math.min(1, flight.t + 0.04);
      const k = flight.t * flight.t * (3 - 2 * flight.t);
      const target = flight.from.clone().lerp(flight.to, k);
      const delta = target.clone().sub(controls.target);
      controls.target.copy(target);
      if (flight.offsetTo) {
        camera.position.copy(target).add(flight.offsetFrom.clone().lerp(flight.offsetTo, k));
      } else {
        camera.position.add(delta);
      }
      if (flight.t >= 1) flight = null;
    }
    controls.update();
    ring.rotation.z += 0.01;
    renderer.render(scene, camera);
  });

  return {
    backend,
    load,
    setSelected,
    onSelect: (l) => {
      selectListeners.push(l);
    },
    screenOf,
    pinOf(key) {
      const p = (city ? placesOf(city) : []).find((x) => x.key === key);
      return p ? screenOf(p.at[0], p.at[1], mapBlock(p)[1] + 6) : null;
    },
    setLife,
    setPlan,
    roadAt,
    groundAt,
    focus(key, opts = {}) {
      const p = (city ? placesOf(city) : []).find((x) => x.key === key);
      if (!p) return;
      const offsetFrom = camera.position.clone().sub(controls.target);
      // Close, but with the three nearest places in view: a city isn't just your front door.
      const around = (city ? placesOf(city) : [])
        .filter((x) => x.key !== key)
        .map((x) => Math.hypot(x.at[0] - p.at[0], x.at[1] - p.at[1]))
        .sort((a, b) => a - b)[2];
      const zoomOut = Math.max(1, Math.min(CLOSE_MAX_ZOOM_OUT, (around ?? 0) / CLOSE_SEES_M));
      flight = {
        from: controls.target.clone(),
        to: new THREE.Vector3(p.at[0], 0, p.at[1]),
        camFrom: camera.position.clone(),
        offsetFrom,
        // Close: about 1.2 km out and 40 degrees down: buildings to read, and the places around.
        offsetTo: opts.close ? new THREE.Vector3(310, 890, 1060).multiplyScalar(zoomOut) : null,
        t: 0,
      };
    },
    setTime(minuteOfDay) {
      const day = Math.max(0, Math.sin(dayPhase(city?.sun, minuteOfDay) * Math.PI));
      sun.intensity = 0.25 + 1.75 * day;
      sun.color.set("#9fb3e0").lerp(new THREE.Color("#fff0d8"), Math.min(1, day * 2));
      hemi.intensity = 0.45 + 1.65 * day;
      hemi.color.set("#7d8fc4").lerp(new THREE.Color("#ffffff"), Math.min(1, day * 2));
    },
    resize,
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      clear();
      setPlan(null);
      ring.geometry.dispose();
      environment.dispose();
      pmrem.dispose();
      for (const g of Object.values(lifeGeo)) g.dispose();
      for (const m of Object.values(lifeMat)) m.dispose();
      renderer.dispose();
    },
  };
}

/** Flat strips along polylines, merged into one geometry at height `y`, or null if none. */
function stripGeometry(
  roads: readonly { points: readonly (readonly [number, number])[]; widthM: number }[],
  y: number,
): THREE.BufferGeometry | null {
  const strips: THREE.BufferGeometry[] = [];
  for (const r of roads) {
    for (let i = 1; i < r.points.length; i++) {
      const [ax, az] = r.points[i - 1] as readonly [number, number];
      const [bx, bz] = r.points[i] as readonly [number, number];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1) continue;
      const g = new THREE.BoxGeometry(len + r.widthM, 1.5, r.widthM);
      g.rotateY(-Math.atan2(bz - az, bx - ax));
      g.translate((ax + bx) / 2, y, (az + bz) / 2);
      strips.push(g.toNonIndexed());
      g.dispose();
    }
  }
  if (strips.length === 0) return null;
  const merged = mergeGeometries(strips);
  for (const g of strips) g.dispose();
  return merged;
}

function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const g of parts) {
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    for (let i = 0; i < p.count; i++) {
      positions.push(p.getX(i), p.getY(i), p.getZ(i));
      normals.push(n.getX(i), n.getY(i), n.getZ(i));
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  return out;
}

function inside(x: number, z: number, poly: readonly (readonly [number, number])[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i] as readonly [number, number];
    const [xj, zj] = poly[j] as readonly [number, number];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** A road network as the map draws it (see `RoadNetwork` in @aye/schema). */
export interface MapNetwork {
  nodes: readonly number[];
  /** Rows of [a, b, lanes each way, km/h, one-way, class, name]. */
  links: readonly number[];
  shapeAt: readonly number[];
  shape: readonly number[];
}

/** The last road class (`LAST_ROAD_CLASS` in @aye/schema); ferry 6, rail 7, access 8. */
const LAST_ROAD = 5;
const FERRY = 6;
const RAIL = 7;

/** A real city's ground cover as the map draws it (see `LandCover` in @aye/schema). */
export interface MapLand {
  /** Per ring: built-up, industrial, green or water (0–3). */
  kinds: readonly number[];
  /** Per ring: 1 if it is a hole in the ring before it that isn't. */
  holes: readonly number[];
  ringAt: readonly number[];
  points: readonly number[];
}

/** A network's links as polylines with a width: lanes × 3.5 m, both ways unless one-way. */
export function networkRoads(
  n: MapNetwork,
): { points: [number, number][]; widthM: number; cls: number }[] {
  const out: { points: [number, number][]; widthM: number; cls: number }[] = [];
  for (let l = 0; l * 7 < n.links.length; l++) {
    const r = l * 7;
    const a = n.links[r] as number;
    const b = n.links[r + 1] as number;
    const lanes = (n.links[r + 2] as number) * (n.links[r + 4] ? 1 : 2);
    const points: [number, number][] = [[n.nodes[a * 2] as number, n.nodes[a * 2 + 1] as number]];
    for (let k = n.shapeAt[l] as number; k < (n.shapeAt[l + 1] as number); k++) {
      points.push([n.shape[k * 2] as number, n.shape[k * 2 + 1] as number]);
    }
    points.push([n.nodes[b * 2] as number, n.nodes[b * 2 + 1] as number]);
    const cls = n.links[r + 5] as number;
    // Lines are drawn as lines (a ferry route, a track), not as wide as lanes.
    out.push({ points, widthM: cls > LAST_ROAD ? 8 : Math.max(6, lanes * 3.5), cls });
  }
  return out;
}
