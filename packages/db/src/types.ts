import type { Json } from "@aye/schema";

/** A validated player intent as stored in the command log. */
export type CommandLogEntry = { type: string } & { [key: string]: Json };
