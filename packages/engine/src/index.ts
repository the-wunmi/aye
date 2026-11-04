/** The engine's public surface: the place renderer, city map, figure preview, realm connection. */
export {
  type CityMap,
  createCityMap,
  type MapLand,
  type MapNetwork,
  networkRoads,
} from "./city-map.ts";
export { interpolatePositions } from "./interpolate.ts";
export { createFigurePreview, type FigurePreview } from "./preview.ts";
export { connectRealm, type RealmClient, type RealmStatus } from "./realm-client.ts";
export {
  type AgentFrame,
  createRenderer,
  type PlacementCheck,
  type Renderer,
  type StateFrame,
  type ThingLayout,
} from "./renderer.ts";
export { aimAhead, type Footing } from "./steer.ts";
