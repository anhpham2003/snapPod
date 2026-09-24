import { NextResponse } from "next/server";
import { z } from "zod";
import { hasValidProcessorToken } from "~/server/callback-auth";
import { db } from "~/server/db";

const payloadSchema = z.object({
  projectId: z.string().min(1),
  jobId: z.string().min(1),
  processingVersion: z.number().int().positive(),
  stage: z.enum([
    "PREPARING_VIDEO",
    "TRANSCRIBING",
    "IDENTIFYING_MOMENTS",
    "CREATING_CLIPS",
    "ADDING_CAPTIONS",
    "FINALIZING",
  ]),
  progressPercent: z.number().int().min(0).max(99),
  processedClipCount: z.number().int().min(0).optional(),
  requestedClipCount: z.number().int().min(0).optional(),
});

export async function POST(request: Request) {
  if (!hasValidProcessorToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid progress payload" },
      { status: 400 },
    );
  }

  const { projectId, jobId, processingVersion } = parsed.data;
  const progress = {
    processingStage: parsed.data.stage,
    progressPercent: parsed.data.progressPercent,
    ...(parsed.data.processedClipCount === undefined
      ? {}
      : { processedClipCount: parsed.data.processedClipCount }),
  };
  const accepted = await db.$transaction(async (tx) => {
    const job = await tx.processingJob.updateMany({
      where: {
        id: jobId,
        uploadedFileId: projectId,
        processingVersion,
        status: { in: ["QUEUED", "DISPATCHED", "PROCESSING"] },
      },
      data: {
        status: "PROCESSING",
        ...progress,
        heartbeatAt: new Date(),
      },
    });
    if (job.count !== 1) return false;

    await tx.uploadedFile.updateMany({
      where: { id: projectId, processingVersion },
      data: { status: "PROCESSING", ...progress },
    });
    return true;
  });

  return NextResponse.json({ accepted });
}
