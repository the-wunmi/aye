/**
 * Tests for people answering players: who may speak, what reaches the chat, and what counts as an
 * offer.
 */
import { MemoryArtifactStore, MemoryRecipeIndex } from "@aye/artifacts";
import { describe, expect, it } from "vitest";
import {
  type Conversationalist,
  type ConverseBrief,
  type ConverseDraft,
  compileReply,
  converse,
} from "../src/index.ts";

const people = [
  { key: "esi", name: "Auntie Esi" },
  { key: "kofi", name: "Kofi" },
];
const brief: ConverseBrief = {
  city: "Accra: Makola noise, Osu lights",
  place: { name: "Bukom compound", about: "Home." },
  people: [
    { name: "Auntie Esi", about: "Runs the compound.", remembers: "" },
    { name: "Kofi", about: "Her nephew.", remembers: "" },
  ],
  player: { name: "Wunmi", said: "", arrived: true },
  recent: [],
  offers: [{ label: "Buy waakye", thing: "Waakye pot", costs: "15.00 GHS", pays: "" }],
};

describe("people answering players", () => {
  it("only someone who is there answers, in bounded words", () => {
    const draft = (over: Partial<ConverseDraft>): ConverseDraft => ({
      warmth: 0,
      speaker: "Auntie Esi",
      text: "Akwaaba, Wunmi! You've eaten?",
      remember: "Wunmi: new here, polite.",
      offer: "",
      ...over,
    });
    expect(compileReply(draft({}), people)).toEqual({
      person: "esi",
      warmth: 0,
      name: "Auntie Esi",
      text: "Akwaaba, Wunmi! You've eaten?",
      remember: "Wunmi: new here, polite.",
    });
    // Nobody, someone who isn't here, or nothing to say: no reply.
    expect(compileReply(draft({ speaker: "" }), people)).toBeNull();
    expect(compileReply(draft({ speaker: "The President" }), people)).toBeNull();
    expect(compileReply(draft({ text: "   " }), people)).toBeNull();
    // Control characters never reach the chat.
    const bel = String.fromCodePoint(0x07);
    const rlo = String.fromCodePoint(0x202e);
    const r = compileReply(draft({ text: `hi${bel} there${rlo}` }), people);
    expect(r?.text).toBe("hi there");
  });

  it("offers only what can really be done there, as the place has it", () => {
    const offers = [{ kind: "waakye_pot", action: "buy", label: "Buy waakye" }];
    const draft = (offer: string): ConverseDraft => ({
      warmth: 0,
      speaker: "Auntie Esi",
      text: "Sit, I go dish am.",
      remember: "",
      offer,
    });
    expect(compileReply(draft("buy  WAAKYE"), people, offers)?.offer).toEqual(offers[0]);
    // Something the place can't do (or no offer at all) is just talk.
    expect(compileReply(draft("Give free money"), people, offers)?.offer).toBeUndefined();
    expect(compileReply(draft(""), people, offers)?.offer).toBeUndefined();
  });

  it("is a memoised stage: the same moment replays with no call", async () => {
    let calls = 0;
    const voice: Conversationalist = {
      model: { provider: "test", model: "voice", version: "1" },
      prompt: "speak",
      effort: "low",
      async reply() {
        calls++;
        return {
          speaker: "Kofi",
          text: "Eh, Wunmi! Come sit.",
          remember: "Wunmi came by.",
          offer: "",
        };
      },
    };
    const deps = { voice, store: new MemoryArtifactStore(), index: new MemoryRecipeIndex() };
    const a = await converse(brief, people, deps);
    const b = await converse(brief, people, deps);
    expect(a.reply?.person).toBe("kofi");
    expect(b.reply).toEqual(a.reply);
    expect(calls).toBe(1);
    expect(b.called).toBe(false);
  });
});
