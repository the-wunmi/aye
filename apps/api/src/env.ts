/**
 * Environment configuration, validated once at startup. Missing or malformed config is a
 * boot failure, never a runtime surprise. Secrets are read from the environment only and
 * never logged.
 */
import { fileURLToPath } from "node:url";
import { z } from "zod";

const Env = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    WEB_ORIGIN: z
      .string()
      .default("http://localhost:5173")
      .transform((s) =>
        s
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.url()).min(1)),
    /** Shared with the worker. Defaults to the repo's .aye/ in development. */
    AYE_ARTIFACT_DIR: z
      .string()
      .min(1)
      .default(fileURLToPath(new URL("../../../.aye/artifacts", import.meta.url))),
    /**
     * Development-only identity header (x-aye-dev-user), honoured only without a session.
     * Refused in production so it can never become a backdoor.
     */
    AYE_DEV_AUTH: z.enum(["0", "1"]).default("0"),
    /**
     * Lets people play without signing up, as guests. They can't spend model credit until they
     * add a name and password. Off unless this deployment says so.
     */
    ALLOW_ANONYMOUS: z.enum(["0", "1"]).default("0"),
    /** For speech to text only (voices aren't kept, so this can't go through the worker). */
    MUSE_API_KEY: z.string().min(16).optional(),
  })
  .refine((e) => !(e.NODE_ENV === "production" && e.AYE_DEV_AUTH === "1"), {
    message: "AYE_DEV_AUTH must not be enabled in production",
    path: ["AYE_DEV_AUTH"],
  });

export type Env = z.infer<typeof Env>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = Env.safeParse(source);
  if (!result.success) {
    // Report which keys are wrong, never their values.
    const keys = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid environment — ${keys}`);
  }
  return result.data;
}
