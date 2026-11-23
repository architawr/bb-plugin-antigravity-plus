import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const swarmMemberSchema = z
  .object({
    name: z.string(),
    role: z.string(),
    phase: z.string(),
    model: z.string().nullable(),
    workspaceMode: z.string().nullable(),
    killed: z.boolean(),
    lastReadSeq: z.number().int().nullable(),
  })
  .strict();

export type SwarmMember = z.infer<typeof swarmMemberSchema>;

export const swarmMessageSchema = z
  .object({
    seq: z.number().int(),
    agent: z.string(),
    text: z.string(),
    time: z.string().nullable(),
    kind: z.string().nullable(),
    channel: z.string().nullable(),
  })
  .strict();

export type SwarmMessage = z.infer<typeof swarmMessageSchema>;

export const swarmPlanThreadSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    goal: z.string().nullable(),
    tasks: z.array(z.string()),
  })
  .strict();

export const swarmPlanSchema = z
  .object({
    goalTitle: z.string().nullable(),
    goalLine: z.string().nullable(),
    tasks: z.record(z.string(), z.string()),
    threads: z.array(swarmPlanThreadSchema),
  })
  .strict();

export type SwarmPlan = z.infer<typeof swarmPlanSchema>;

export const swarmBoardSnapshotSchema = z
  .object({
    exists: z.boolean(),
    providerThreadId: z.string().nullable(),
    title: z.string().nullable(),
    swarmId: z.string().nullable(),
    createdAt: z.string().nullable(),
    plan: swarmPlanSchema.nullable(),
    members: z.array(swarmMemberSchema),
    messages: z.array(swarmMessageSchema),
    totalMessages: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export type SwarmBoardSnapshot = z.infer<typeof swarmBoardSnapshotSchema>;

export function emptySwarmBoardSnapshot(providerThreadId: string | null = null): SwarmBoardSnapshot {
  return {
    exists: false,
    providerThreadId,
    title: null,
    swarmId: null,
    createdAt: null,
    plan: null,
    members: [],
    messages: [],
    totalMessages: 0,
    truncated: false,
  };
}

export const swarmHostContract = {
  readSwarmBoard: {
    experimental_retryable: true,
    input: z
      .object({
        providerThreadId: z.string().min(1),
      })
      .strict(),
    output: swarmBoardSnapshotSchema,
  },
} as const satisfies PluginRpcContract;

export const swarmRpcContract = {
  getSwarmBoard: {
    input: z
      .object({
        threadId: z.string().min(1),
      })
      .strict(),
    output: swarmBoardSnapshotSchema,
    tags: ({ threadId }: { threadId: string }) => [`swarm:${threadId}`],
  },
} as const satisfies PluginRpcContract;
