/**
 * Postgres-backed RecipeIndex: the shared memo table that lets every worker reuse every
 * previously generated artifact.
 */
import { type ArtifactHash, StageRecord } from "@aye/schema";
import { eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import { recipes } from "./schema.ts";

export class PgRecipeIndex {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async lookup(recipeHash: ArtifactHash): Promise<StageRecord | null> {
    const [row] = await this.#db
      .select()
      .from(recipes)
      .where(eq(recipes.recipeHash, recipeHash))
      .limit(1);
    return row ? StageRecord.parse(row.record) : null;
  }

  async record(entry: StageRecord): Promise<void> {
    const record = StageRecord.parse(entry);
    await this.#db
      .insert(recipes)
      .values({ recipeHash: record.recipeHash, record })
      .onConflictDoNothing();
  }
}
