/** The rules in policy.ts, stated as who may do what. */
import type { UserId } from "@aye/schema";
import { describe, expect, it } from "vitest";
import {
  type Actor,
  canEditPlace,
  canEditWorld,
  canListPlace,
  canManageWorldMembers,
  canPlayWorld,
  canReadCapture,
  canReadPlace,
  canReadWorld,
  geoForViewer,
} from "../src/policy.ts";

const alice: Actor = { kind: "user", userId: "usr_alice" as UserId };
const bob: Actor = { kind: "user", userId: "usr_bob" as UserId };
const anon: Actor = { kind: "anonymous" };

describe("place policy", () => {
  const priv = { ownerId: "usr_alice", visibility: "private" as const };
  const unlisted = { ownerId: "usr_alice", visibility: "unlisted" as const };
  const pub = { ownerId: "usr_alice", visibility: "public" as const };

  it("private places: owner only, unless shared through a world", () => {
    expect(canReadPlace(alice, priv)).toBe(true);
    expect(canReadPlace(bob, priv)).toBe(false);
    expect(canReadPlace(anon, priv)).toBe(false);
    expect(canReadPlace(bob, priv, "viewer")).toBe(true);
  });

  it("unlisted is readable by link but never listed", () => {
    expect(canReadPlace(bob, unlisted)).toBe(true);
    expect(canListPlace(bob, unlisted)).toBe(false);
    expect(canListPlace(bob, pub)).toBe(true);
  });

  it("only the owner edits, whatever the visibility or world role", () => {
    expect(canEditPlace(alice, pub)).toBe(true);
    expect(canEditPlace(bob, pub)).toBe(false);
    expect(canEditPlace(anon, pub)).toBe(false);
  });

  it("raw captures are owner-only", () => {
    expect(canReadCapture(alice, { ownerId: "usr_alice" })).toBe(true);
    expect(canReadCapture(bob, { ownerId: "usr_alice" })).toBe(false);
    expect(canReadCapture(anon, { ownerId: "usr_alice" })).toBe(false);
  });
});

describe("world roles", () => {
  it.each([
    ["owner", true, true, true, true],
    ["editor", true, true, true, false],
    ["player", true, true, false, false],
    ["viewer", true, false, false, false],
    [null, false, false, false, false],
  ] as const)("%s", (role, read, play, edit, manage) => {
    expect(canReadWorld(role)).toBe(read);
    expect(canPlayWorld(role)).toBe(play);
    expect(canEditWorld(role)).toBe(edit);
    expect(canManageWorldMembers(role)).toBe(manage);
  });
});

describe("geoForViewer", () => {
  const exact = { lat: 6.524379, lng: 3.379206, bearingDeg: 10, precision: "exact" as const };

  it("owners see what they stored", () => {
    expect(geoForViewer(exact, true)).toEqual(exact);
  });

  it("everyone else gets at most street precision", () => {
    expect(geoForViewer(exact, false)).toEqual({
      lat: 6.524,
      lng: 3.379,
      bearingDeg: 10,
      precision: "street",
    });
    expect(geoForViewer({ ...exact, precision: "city" }, false)).toMatchObject({
      lat: 6.5,
      lng: 3.4,
    });
    expect(geoForViewer({ ...exact, precision: "none" }, true)).toBeNull();
  });
});
