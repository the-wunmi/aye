import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// Load the repo-root .env for local CLI use; CI and production set the environment directly.
const rootEnv = new URL("../../.env", import.meta.url);
if (!process.env["DATABASE_URL"] && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  extensionsFilters: ["postgis"],
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "" },
});
