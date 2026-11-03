/**
 * Hashing and identifiers.
 *
 * BLAKE3 everywhere: fast in pure JS, and a 256-bit digest so content addresses never collide
 * in practice. Ids use 128 bits of either a hash (derived ids) or CSPRNG output (random ids),
 * encoded in lowercase Crockford base32 to satisfy the `<prefix>_[0-9a-z]+` id grammar.
 */

import { ArtifactHash, ID_PREFIX, type IdKind, Recipe } from "@aye/schema";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalJson } from "./canonical.ts";

const encoder = new TextEncoder();

export function hashBytes(bytes: Uint8Array): ArtifactHash {
  return ArtifactHash.parse(`b3:${bytesToHex(blake3(bytes))}`);
}

export function hashJson(value: unknown): ArtifactHash {
  return hashBytes(encodeJson(value));
}

/** Canonical UTF-8 bytes for a JSON value. Store JSON artifacts with exactly these bytes. */
export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value));
}

/** The cache key of a pipeline stage. Validates first so malformed recipes never get a key. */
export function recipeHash(recipe: Recipe): ArtifactHash {
  return hashJson(Recipe.parse(recipe));
}

/** A deterministic 31-bit seed from any JSON value, for stochastic stages and the simulation. */
export function seedFrom(value: unknown): number {
  const digest = blake3(encodeJson(value));
  return (
    (((digest[0] ?? 0) << 23) |
      ((digest[1] ?? 0) << 15) |
      ((digest[2] ?? 0) << 7) |
      ((digest[3] ?? 0) >> 1)) >>>
    0
  );
}

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * Id derived from provenance, e.g. `deriveId("object", [captureId, trackId])`. Re-running a
 * pipeline stage on the same input reproduces the same ids, which is what lets user edits
 * (keyed by id) be replayed onto a regenerated scene.
 */
export function deriveId<K extends IdKind>(
  kind: K,
  parts: unknown,
): `${(typeof ID_PREFIX)[K]}_${string}` {
  const digest = blake3(encodeJson([kind, parts]));
  return `${ID_PREFIX[kind]}_${base32(digest.subarray(0, 16))}`;
}

/** Unguessable id for root records. Never rely on this for authorisation; always check ownership. */
export function randomId<K extends IdKind>(kind: K): `${(typeof ID_PREFIX)[K]}_${string}` {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `${ID_PREFIX[kind]}_${base32(bytes)}`;
}
