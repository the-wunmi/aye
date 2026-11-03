/**
 * Starting the renderer on whatever the device has. WebGPU where it answers, WebGL2 where it
 * doesn't: a phone or a busy browser can leave the request for a graphics adapter hanging for
 * minutes, and nobody should stare at an empty screen while the world carries on without them.
 */
import * as THREE from "three/webgpu";

/** How long a device gets to offer WebGPU before we stop waiting for it. */
const ADAPTER_WAIT_MS = 4_000;

/** Asked once: a device that hung for the place shouldn't get to hang again for the map. */
let answer: Promise<boolean> | null = null;

function hasWebGpu(): Promise<boolean> {
  answer ??= askForWebGpu();
  return answer;
}

async function askForWebGpu(): Promise<boolean> {
  const gpu = (globalThis.navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return false;
  const timedOut = new Promise<null>((resolve) => setTimeout(() => resolve(null), ADAPTER_WAIT_MS));
  const adapter = await Promise.race([gpu.requestAdapter().catch(() => null), timedOut]);
  return adapter !== null;
}

export async function startRenderer(canvas: HTMLCanvasElement): Promise<THREE.WebGPURenderer> {
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    alpha: true,
    forceWebGL: !(await hasWebGpu()),
  });
  await renderer.init();
  // WebGL's dispose destroys the context, and a canvas only ever has one: a renderer replaced on
  // the same canvas would take its successor down with it. The context goes with the canvas.
  const backend = renderer.backend as { isWebGPUBackend?: boolean; dispose?: () => void };
  if (!backend.isWebGPUBackend) backend.dispose = () => undefined;
  return renderer;
}
