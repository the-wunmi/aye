import type { Layout, Thread, Widget } from "@aye/schema";
import { describe, expect, it } from "vitest";
import { arrange, compactHud, currentStep } from "../src/game/Hud.tsx";

describe("arrange", () => {
  it("keeps cards out of the centre column and keeps every widget", () => {
    const layout: Layout = [
      {
        region: "top",
        widgets: [
          { type: "wallet" },
          { type: "needs", style: "bars", show: "all" },
          { type: "people" },
        ],
      },
      { region: "bottom", widgets: [{ type: "chat" }, { type: "feed" }, { type: "phone" }] },
      { region: "left", widgets: [{ type: "feed" }] },
    ] as Layout;
    const out = arrange(layout);
    const top = out.get("top") ?? [];
    const bottom = out.get("bottom") ?? [];
    // ...and a layout without a clock gets one (top centre).
    expect(top.map((w) => w.type)).toEqual(["wallet", "needs", "clock"]);
    // Needs stay where the model wanted them, as compact chips.
    expect(top[1]).toMatchObject({ type: "needs", style: "chips" });
    expect(bottom.map((w) => w.type)).toEqual(["phone"]);
    expect(out.get("top_right")?.map((w) => w.type)).toEqual(["people"]);
    expect(out.get("bottom_left")?.map((w) => w.type)).toEqual(["chat", "feed"]);
    // A layout without threads still shows them (what you're in the middle of never hides).
    expect(out.get("left")?.map((w) => w.type)).toEqual(["feed", "threads"]);
    const count = [...out.values()].reduce((n, ws) => n + ws.length, 0);
    expect(count).toBe(9);
  });

  it("doesn't add threads where the layout already has them", () => {
    const out = arrange([
      { region: "right", widgets: [{ type: "threads" }, { type: "clock", style: "sun" }] },
    ] as Layout);
    const all = [...out.values()].flat();
    expect(all.filter((w) => w.type === "threads")).toHaveLength(1);
    expect(all.filter((w) => w.type === "clock")).toHaveLength(1);
    expect(out.get("right")?.map((w) => w.type)).toEqual(["threads", "clock"]);
  });
});

describe("compactHud", () => {
  const types = (ws: readonly Widget[]) => ws.map((w) => w.type);

  it("keeps every widget of any layout, whichever region it was in", () => {
    const layouts: Layout[] = [
      [
        { region: "top", widgets: [{ type: "clock", style: "digital" }, { type: "threads" }] },
        {
          region: "top_left",
          widgets: [{ type: "wallet" }, { type: "needs", style: "bars", show: "all" }],
        },
        { region: "bottom_left", widgets: [{ type: "ticker" }, { type: "life" }] },
        {
          region: "bottom_right",
          widgets: [
            { type: "panel", panel: "anything" },
            { type: "button", label: "Go", icon: "x", intent: { do: "map" } },
          ],
        },
        { region: "bottom", widgets: [{ type: "trip" }] },
        { region: "right", widgets: [{ type: "chat" }, { type: "people" }, { type: "plan" }] },
        { region: "left", widgets: [{ type: "feed" }, { type: "brand" }, { type: "presence" }] },
      ],
      [{ region: "bottom", widgets: [{ type: "wallet" }, { type: "chat" }] }],
      [],
    ];
    for (const layout of layouts) {
      const regions = arrange(layout);
      const fold = compactHud(regions);
      const folded = [
        ...fold.strip,
        ...fold.status,
        ...fold.dock,
        ...fold.tools,
        ...fold.float,
        ...(fold.threads ? [{ type: "threads" } as Widget] : []),
      ];
      expect(types(folded).sort()).toEqual(types([...regions.values()].flat()).sort());
    }
  });

  it("sorts by what a widget is for, not where a city put it", () => {
    const fold = compactHud(
      arrange([
        { region: "bottom", widgets: [{ type: "wallet" }, { type: "plan" }] },
        { region: "top", widgets: [{ type: "panel", panel: "anything" }, { type: "feed" }] },
      ]),
    );
    expect(types(fold.strip).sort()).toEqual(["clock", "wallet"]);
    expect(types(fold.dock)).toEqual(["panel"]);
    expect(types(fold.tools)).toEqual(["plan"]);
    expect(types(fold.float)).toEqual(["feed"]);
    expect(fold.threads).toBe(true);
    expect(fold.needs).toBeNull();
  });
});

describe("currentStep", () => {
  const step = { check: "go", place: "p", text: "Go there" } as unknown as Thread["steps"][number];
  const thread = (over: Partial<Thread>): Thread =>
    ({
      id: "t",
      icon: "x",
      title: "A job",
      about: "About it",
      state: "open",
      due: 1000,
      progress: 0,
      steps: [step],
      ...over,
    }) as Thread;

  it("shows a job's step before what you're working towards", () => {
    const now = currentStep(
      [thread({ id: "a", aim: true, title: "Aim" }), thread({ id: "b" })],
      10,
    );
    expect(now).toMatchObject({ title: "A job", step: "Go there", more: 1 });
    expect(now?.target).toEqual({ place: "p", label: "Go there" });
  });

  it("is nothing when nothing is open, or it's long past due", () => {
    expect(currentStep([], 10)).toBeNull();
    expect(currentStep([thread({ state: "done" as Thread["state"] })], 10)).toBeNull();
    expect(currentStep([thread({ due: 0 })], 1_000_000)).toBeNull();
  });
});
