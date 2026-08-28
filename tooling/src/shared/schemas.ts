import { z } from "zod";

const id = z.string().trim().min(1).max(255);
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const metadata = z.record(z.string(), z.unknown()).default({});

export const plannedScreenSchema = z.object({
  mobbinScreenId: id,
  position: z.number().int().min(1),
  restricted: z.boolean().default(false),
  metadata,
});

export const plannedFlowSchema = z.object({
  mobbinFlowId: id,
  name: z.string().trim().min(1).max(255),
  restricted: z.boolean().default(false),
  metadata,
  screens: z.array(plannedScreenSchema).min(1),
});

export const runPlanSchema = z.object({
  appSlug: slug,
  appName: z.string().trim().min(1).max(255),
  mobbinAppId: id,
  platform: z.string().trim().min(1).max(32),
  version: z.object({
    mobbinVersionId: id,
    publishedAt: z.iso.datetime().nullable().default(null),
    metadata,
  }),
  flows: z.array(plannedFlowSchema).min(1),
});

export const screenUploadMetadataSchema = z.object({
  mobbinScreenId: id,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(64 * 1024 * 1024),
  width: z.number().int().min(100),
  height: z.number().int().min(100),
  contentType: z.literal("image/webp"),
  descriptor: z.string().trim().min(1).max(100),
});

export type RunPlan = z.infer<typeof runPlanSchema>;
export type PlannedFlow = z.infer<typeof plannedFlowSchema>;
export type PlannedScreen = z.infer<typeof plannedScreenSchema>;
export type ScreenUploadMetadata = z.infer<typeof screenUploadMetadataSchema>;
