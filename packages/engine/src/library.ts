/**
 * Loads the asset library's files for drawing: things, rigged outfits with their
 * shared animations, and surface textures. Only ever by catalog id: the catalog is code's,
 * so a spec can name an entry but never a file or a URL.
 *
 * Each file is fetched once and shared; every use gets its own clone (skinned outfits are
 * cloned with their skeletons). A missing or broken file resolves to null, and callers keep
 * drawing primitives, so a library that was never fetched just means the plainer look.
 */
import { LIBRARY_CATALOG, type LibraryCatalog, libraryIndex, type OutfitAsset } from "@aye/schema";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import * as THREE from "three/webgpu";

export interface Outfit {
  root: THREE.Object3D;
  /** Clip by purpose (idle, walk, run, interact, wave); absent ones are simply missing. */
  clips: Map<string, THREE.AnimationClip>;
  asset: OutfitAsset;
}

export interface Library {
  readonly catalog: LibraryCatalog;
  /** A fresh copy of a thing's model, or null. */
  thing(id: string): Promise<THREE.Object3D | null>;
  /** A fresh, rigged copy of an outfit with the shared clips, or null. */
  outfit(id: string): Promise<Outfit | null>;
  /** A surface's colour map, set to repeat every `tileMm`, or null. */
  surface(id: string): Promise<{ map: THREE.Texture; tileM: number; tintable: boolean } | null>;
}

const libraries = new Map<string, Library>();

/** The library served under `base` (default `/library/`), shared by every renderer. */
export function getLibrary(base = "/library/", catalog: LibraryCatalog = LIBRARY_CATALOG): Library {
  const existing = libraries.get(base);
  if (existing) return existing;
  const index = libraryIndex(catalog);
  // Library files are meshopt-compressed (smaller downloads); three ships the decoder.
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const files = new Map<
    string,
    Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] } | null>
  >();
  const load = (file: string) => {
    let p = files.get(file);
    if (!p) {
      p = loader
        .loadAsync(`${base}${file}`)
        .then((g) => ({ scene: g.scene, animations: g.animations }))
        .catch(() => null);
      files.set(file, p);
    }
    return p;
  };
  const textures = new Map<string, Promise<THREE.Texture | null>>();
  const textureLoader = new THREE.TextureLoader();

  const shadows = (o: THREE.Object3D) => {
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    return o;
  };

  const library: Library = {
    catalog,
    async thing(id) {
      const asset = index.thing(id);
      if (!asset) return null;
      const g = await load(asset.file);
      return g ? shadows(g.scene.clone(true)) : null;
    },
    async outfit(id) {
      const asset = index.outfit(id);
      const anims = catalog.animations;
      if (!asset) return null;
      const [g, a] = await Promise.all([load(asset.file), anims ? load(anims.file) : null]);
      if (!g) return null;
      const root = shadows(cloneSkinned(g.scene));
      const clips = new Map<string, THREE.AnimationClip>();
      if (anims && a) {
        // Keep only tracks for joints this outfit has (outfits differ in fingers and helpers).
        const joints = new Set<string>();
        root.traverse((o) => joints.add(o.name));
        for (const [purpose, name] of Object.entries(anims.clips)) {
          const clip = a.animations.find((c) => c.name === name);
          if (!clip) continue;
          const tracks = clip.tracks.filter((t) => joints.has(t.name.split(".")[0] ?? ""));
          clips.set(purpose, new THREE.AnimationClip(clip.name, clip.duration, tracks));
        }
      }
      return { root, clips, asset };
    },
    async surface(id) {
      const asset = index.surface(id);
      if (!asset) return null;
      let p = textures.get(asset.file);
      if (!p) {
        p = textureLoader
          .loadAsync(`${base}${asset.file}`)
          .then((t) => {
            t.wrapS = THREE.RepeatWrapping;
            t.wrapT = THREE.RepeatWrapping;
            t.colorSpace = THREE.SRGBColorSpace;
            t.anisotropy = 8;
            return t;
          })
          .catch(() => null);
        textures.set(asset.file, p);
      }
      const map = await p;
      return map ? { map, tileM: asset.tileMm / 1000, tintable: asset.tintable } : null;
    },
  };
  libraries.set(base, library);
  return library;
}

/**
 * Recolour an outfit's slots with a person's colours: materials are cloned per person, so
 * people sharing an outfit keep their own colours.
 */
export function colourOutfit(
  outfit: Outfit,
  colours: { skin: string; top: string; bottom: string; hair?: string | undefined },
): THREE.Material[] {
  const bySlot = new Map<string, string>();
  for (const name of outfit.asset.slots.skin) bySlot.set(name, colours.skin);
  for (const name of outfit.asset.slots.top) bySlot.set(name, colours.top);
  for (const name of outfit.asset.slots.bottom) bySlot.set(name, colours.bottom);
  if (colours.hair) for (const name of outfit.asset.slots.hair) bySlot.set(name, colours.hair);
  const made: THREE.Material[] = [];
  const cloned = new Map<THREE.Material, THREE.Material>();
  outfit.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const recolour = (m: THREE.Material) => {
      const colour = bySlot.get(m.name);
      if (!colour) return m;
      let c = cloned.get(m);
      if (!c) {
        c = m.clone();
        (c as THREE.MeshStandardMaterial).color?.set(colour);
        cloned.set(m, c);
        made.push(c);
      }
      return c;
    };
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(recolour)
      : recolour(mesh.material);
  });
  return made;
}

/**
 * Fit a model into a thing's measured box (metres): turned a quarter if its footprint runs
 * the other way, scaled evenly across the floor to fit inside, its height kept close to its
 * own proportions, standing on the floor and centred. Physics uses the box; this is a look.
 */
export function fitInto(model: THREE.Object3D, w: number, h: number, d: number): THREE.Object3D {
  const holder = new THREE.Group();
  holder.add(model);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  if (size.x <= 0 || size.y <= 0 || size.z <= 0) return holder;
  const turn = (w > d * 1.25 && size.z > size.x * 1.25) || (d > w * 1.25 && size.x > size.z * 1.25);
  const ax = turn ? size.z : size.x;
  const az = turn ? size.x : size.z;
  const floor = Math.min(w / ax, d / az);
  const up = Math.min(Math.max(h / size.y, floor * 0.7), floor * 1.4);
  const centre = box.getCenter(new THREE.Vector3());
  model.position.set(-centre.x, -box.min.y, -centre.z);
  const turned = new THREE.Group();
  turned.add(model);
  if (turn) turned.rotation.y = Math.PI / 2;
  holder.clear();
  holder.add(turned);
  holder.scale.set(floor, up, floor);
  return holder;
}
