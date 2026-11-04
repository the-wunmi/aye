import { describe, expect, it } from "vitest";
import { ModelTraffic } from "../src/traffic.ts";

const later = () => {
  let finish = () => {};
  const done = new Promise<void>((r) => {
    finish = r;
  });
  return { done, finish };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("keeping someone waiting ahead of polish", () => {
  it("runs only a few background calls at a time, and every one in the end", async () => {
    const traffic = new ModelTraffic();
    const gates = Array.from({ length: 5 }, later);
    let started = 0;
    const calls = gates.map((g) =>
      traffic.background(async () => {
        started++;
        await g.done;
      }),
    );
    await tick();
    expect(started).toBe(3);
    for (const g of gates) g.finish();
    await Promise.all(calls);
    expect(started).toBe(5);
  });

  it("eases to one while someone's waiting, and back afterwards", async () => {
    const traffic = new ModelTraffic();
    const wait = later();
    const waiting = traffic.foreground(() => wait.done);
    const gates = Array.from({ length: 4 }, later);
    let started = 0;
    const calls = gates.map((g) =>
      traffic.background(async () => {
        started++;
        await g.done;
      }),
    );
    await tick();
    expect(started).toBe(1);
    wait.finish();
    await waiting;
    await tick();
    expect(started).toBe(3);
    for (const g of gates) g.finish();
    await Promise.all(calls);
    expect(started).toBe(4);
  });

  it("lets a failed call or failed wait free its place", async () => {
    const traffic = new ModelTraffic();
    await expect(traffic.foreground(() => Promise.reject(new Error("no")))).rejects.toThrow("no");
    await expect(traffic.background(() => Promise.reject(new Error("no")))).rejects.toThrow("no");
    let ran = false;
    await traffic.background(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
