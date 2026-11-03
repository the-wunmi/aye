/**
 * A turntable for one person: how a new character will look, before they step into the city.
 * Same figure and rig as in places (a library outfit when there is one), slowly
 * turning under soft light.
 */
import type { PersonDef } from "@aye/schema";
import * as THREE from "three/webgpu";
import { getLibrary } from "./library.ts";
import { createLivePerson, type Person } from "./people.ts";
import { startRenderer } from "./start-renderer.ts";

export interface FigurePreview {
  show(person: Pick<PersonDef, "key" | "colours" | "look" | "body" | "outfit">): void;
  dispose(): void;
}

export async function createFigurePreview(canvas: HTMLCanvasElement): Promise<FigurePreview> {
  const renderer = await startRenderer(canvas);
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7d6a, 2.2));
  const key = new THREE.DirectionalLight(0xfff1dc, 2.4);
  key.position.set(2, 4, 3);
  key.castShadow = true;
  scene.add(key);
  const floorMat = new THREE.MeshStandardNodeMaterial({ color: "#e9e1d2", roughness: 1 });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(0.9, 48), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const turntable = new THREE.Group();
  scene.add(turntable);
  let person: Person | null = null;
  let height = 1.7;

  const resize = () => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.set(0, height * 0.62, height * 2.6);
    camera.lookAt(0, height * 0.5, 0);
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  let angle = 0.5;
  renderer.setAnimationLoop(() => {
    angle += 0.006;
    turntable.rotation.y = angle;
    person?.update(0, 0, 0, 1 / 60, 255);
    renderer.render(scene, camera);
  });

  return {
    show(def) {
      if (person) {
        turntable.remove(person.root);
        person.dispose();
      }
      person = createLivePerson(def, getLibrary());
      turntable.add(person.root);
      height = (def.look?.heightMm ?? 1700) / 1000;
      resize();
    },
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      person?.dispose();
      floor.geometry.dispose();
      floorMat.dispose();
      renderer.dispose();
    },
  };
}
