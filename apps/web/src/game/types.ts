/** Shapes the game client receives from the API, beyond those in @aye/schema. */
import type { CitySpec, WorldSettings } from "@aye/schema";

export interface CatalogAction {
  kind: string;
  action: string;
  label: string;
  thing: string;
  cost: number;
  income: number;
  durationMin: number;
  needs: { need: string; perHour: number }[];
  /** What doing it builds, by key. */
  marks?: string[];
  /** What someone must have to start it. */
  asks?: { mark: string; op: "gte" | "lte"; value: number }[];
}

/** What each built place offers, by city key. */
export type Catalog = Record<string, { name: string; actions: CatalogAction[] }>;

export interface CityBundle {
  city: CitySpec;
  catalog: Catalog;
  createdAt: string;
  settings: WorldSettings;
  /** The keys of places here that are yours to rearrange. */
  yours?: string[];
  /** Filmed places here you may take away: yours, or any if the city is. */
  removable?: string[];
}

export interface WorldSummary {
  id: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  status: "building" | "ready" | "failed";
  city: string | null;
  owner: boolean;
  joined: boolean;
  madeAt: string;
}
