/** Threads: how steps are checked and advanced, when they're paid, and what rides on them. */
import { describe, expect, it } from "vitest";
import {
  advance,
  THREAD_BOUNDS,
  type Thread,
  type ThreadFacts,
  threadStakes,
} from "../src/index.ts";

const thread: Thread = {
  id: "thr_abcdef1234",
  title: "Chop waakye",
  about: "",
  icon: "\u{1F35A}",
  steps: [
    { check: "be_at", place: "muni", text: "Go" },
    { check: "meet", place: "muni", person: "auntie", text: "Greet" },
    { check: "do", place: "muni", kind: "pot", action: "eat", text: "Eat" },
  ],
  progress: 0,
  reward: 3_500,
  from: 600,
  due: 1_000,
  state: "open",
};
const facts = (over: Partial<ThreadFacts> = {}): ThreadFacts => ({
  place: "muni",
  wallet: 0,
  finished: [],
  present: new Set(["auntie"]),
  ...over,
});

describe("threads", () => {
  it("holds a mark step only with enough of the mark", () => {
    const step = { check: "mark" as const, mark: "cooking", atLeast: 3, text: "Learn to cook" };
    const job = { ...thread, progress: 0, steps: [step] };
    expect(advance(job, facts({ marks: new Map([["cooking", 2]]) }), 700)).toBeNull();
    expect(advance(job, facts({ marks: new Map([["cooking", 3]]) }), 700)?.thread.state).toBe(
      "done",
    );
  });

  it("counts one piece of work once: not for two jobs, not for two steps", () => {
    const shift = { kind: "pot", action: "eat" };
    const job = {
      ...thread,
      progress: 0,
      steps: [{ check: "do" as const, place: "home", kind: "pot", action: "eat", text: "Eat" }],
    };
    const first = advance(job, facts({ place: "home", finished: [shift] }), 700);
    expect(first?.thread.state).toBe("done");
    expect(first?.finished).toEqual([]);
    const second = advance(
      { ...job, id: "other" as never },
      facts({ place: "home", finished: first?.finished ?? [] }),
      700,
    );
    expect(second).toBeNull();
    const twice = { ...job, steps: [job.steps[0]!, job.steps[0]!] };
    const once = advance(twice, facts({ place: "home", finished: [shift] }), 700);
    expect(once?.thread.progress).toBe(1);
    expect(once?.thread.state).toBe("open");
  });

  it("moves through every step that holds, in order, and pays only at the end", () => {
    const r = advance(thread, facts(), 700);
    expect(r?.thread.progress).toBe(2);
    expect(r?.reward).toBe(0);
    // Nothing new: nothing changes.
    expect(advance(r!.thread, facts(), 710)).toBeNull();
    const done = advance(r!.thread, facts({ finished: [{ kind: "pot", action: "eat" }] }), 720);
    expect(done).toMatchObject({
      thread: { ...thread, progress: 3, state: "done" },
      reward: 3_500,
    });
    // Done is done: never paid twice.
    expect(
      advance(done!.thread, facts({ finished: [{ kind: "pot", action: "eat" }] }), 730),
    ).toBeNull();
  });

  it("a step elsewhere, or out of order, doesn't count", () => {
    expect(advance(thread, facts({ place: "club" }), 700)).toBeNull();
    // Eating somewhere else is not eating here.
    const eatenAway = facts({ place: "club", finished: [{ kind: "pot", action: "eat" }] });
    expect(advance(thread, eatenAway, 700)).toBeNull();
  });

  it("finishing a little late still counts; past the grace, it's missed", () => {
    const late = thread.due + THREAD_BOUNDS.graceMinutes - 1;
    const r = advance(
      { ...thread, progress: 2 },
      facts({ finished: [{ kind: "pot", action: "eat" }] }),
      late,
    );
    expect(r?.thread.state).toBe("done");
    expect(r?.reward).toBe(3_500);
    const missed = advance(thread, facts(), thread.due + THREAD_BOUNDS.graceMinutes);
    expect(missed).toMatchObject({ thread: { ...thread, state: "missed" }, reward: 0 });
  });
});

describe("what rides on a thread", () => {
  const thread = (state: "done" | "missed" | "open", progress: number) =>
    ({
      id: "thr_abcdefgh",
      title: "Job",
      about: "",
      icon: "x",
      steps: [
        { check: "have_money", atLeast: 1, text: "a" },
        { check: "have_money", atLeast: 2, text: "b" },
      ],
      progress,
      reward: 0,
      from: 0,
      due: 200,
      state,
      onDone: [{ mark: "cooking", by: 1 }],
      onMissed: [{ mark: "cooking", by: -1 }],
    }) satisfies Thread;

  it("finishing moves what finishing moves", () => {
    expect(threadStakes(thread("done", 2))).toEqual([{ mark: "cooking", by: 1 }]);
  });

  it("letting it slip costs you only once you'd taken it on", () => {
    expect(threadStakes(thread("missed", 1))).toEqual([{ mark: "cooking", by: -1 }]);
    expect(threadStakes(thread("missed", 0))).toEqual([]);
  });

  it("nothing moves while it's open", () => {
    expect(threadStakes(thread("open", 1))).toEqual([]);
  });
});
