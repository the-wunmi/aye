/**
 * What a city does with its building blocks (dev only, reads only): its marks, aims and bills,
 * and for each built place which actions change or ask for what, then whether they connect up:
 * a mark something needs that nothing in the city raises is a dead end.
 *
 *   node --env-file=../../.env scripts/blocks-of.ts <worldId>
 */
import { fileURLToPath } from "node:url";
import { FsArtifactStore } from "@aye/artifacts/node";
import { connect, systemGetPinnedPlace, systemGetWorld } from "@aye/db";
import { readJson } from "@aye/pipeline";
import { type ArtifactHash, CitySpec, placesOf, WorldId, WorldSpec } from "@aye/schema";

const { db, close } = connect(process.env["DATABASE_URL"] as string, { max: 2 });
const store = new FsArtifactStore(
  fileURLToPath(new URL("../../../.aye/artifacts", import.meta.url)),
);
const ref = (h: string) => ({ hash: h as ArtifactHash, mediaType: "application/json", bytes: 0 });

try {
  const worldId = WorldId.parse(process.argv[2]);
  const world = await systemGetWorld(db, worldId);
  if (!world?.city) throw new Error("no such city");
  const city = CitySpec.parse(await readJson(store, ref(world.city)));
  console.log(`${city.name}: ${city.tagline} (${city.currency}, hour ${city.economy.hourPay})`);
  console.log("bills:", JSON.stringify(city.economy.bills));
  console.log(
    "marks:",
    city.marks.map((m) => `${m.label}/${m.max}${m.shown ? "" : "(hidden)"}`).join(", "),
  );
  for (const s of city.starts) {
    console.log(
      `start ${s.label} (${s.money}): ${s.aim?.title ?? "NO AIM"}: ${s.aim?.steps.map((x) => ("mark" in x ? `${x.mark}>=${x.atLeast}` : `money>=${x.money}`)).join(", ")}`,
    );
  }
  const raised = new Set<string>();
  const needed = new Map<string, string[]>();
  for (const s of city.starts) {
    for (const x of s.aim?.steps ?? []) {
      if ("mark" in x) needed.set(x.mark, [...(needed.get(x.mark) ?? []), `aim ${s.label}`]);
    }
  }
  for (const place of placesOf(city)) {
    const pinned = await systemGetPinnedPlace(db, worldId, place.key);
    if (!pinned?.spec) {
      console.log(`\n${place.name}: not built`);
      continue;
    }
    const spec = WorldSpec.parse(await readJson(store, ref(pinned.spec)));
    const lines: string[] = [];
    let actions = 0;
    for (const k of spec.kinds) {
      for (const a of k.actions) {
        actions++;
        for (const m of a.marks ?? []) if (m.by > 0) raised.add(m.mark);
        for (const x of a.asks ?? []) {
          if (x.op === "gte") {
            needed.set(x.mark, [...(needed.get(x.mark) ?? []), `${place.name}: ${a.label}`]);
          }
        }
        if (a.marks?.length || a.asks?.length) {
          lines.push(
            `  ${a.label}${a.income ? ` +${a.income}` : ""}${a.cost ? ` -${a.cost}` : ""}: ${(a.marks ?? []).map((m) => `${m.by > 0 ? "+" : ""}${m.by} ${m.mark}`).join(", ")}${a.asks?.length ? ` [needs ${a.asks.map((x) => `${x.mark}${x.op === "gte" ? ">=" : "<="}${x.value}`).join(", ")}]` : ""}`,
          );
        }
      }
    }
    console.log(`\n${place.name}: ${lines.length} of ${actions} actions use marks`);
    for (const l of lines.slice(0, 14)) console.log(l);
  }
  const dead = [...needed.entries()].filter(([m]) => !raised.has(m) && !m.startsWith("close_"));
  console.log(`\nraised anywhere: ${[...raised].join(", ")}`);
  console.log(
    dead.length === 0
      ? "dead ends: none"
      : `DEAD ENDS: ${dead.map(([m, w]) => `${m} (needed by ${w.slice(0, 3).join("; ")})`).join(" | ")}`,
  );
} finally {
  await close();
}
