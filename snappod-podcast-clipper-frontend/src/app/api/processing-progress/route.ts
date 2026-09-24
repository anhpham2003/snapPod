import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "~/env";
import { db } from "~/server/db";

const payloadSchema = z.object({
  projectId: z.string().min(1),
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
  if (
    request.headers.get("authorization") !==
    `Bearer ${env.PROCESS_VIDEO_ENDPOINT_AUTH}`
  ) {
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

  const { projectId, processingVersion, ...progress } = parsed.data;
  const result = await db.uploadedFile.updateMany({
    where: { id: projectId, processingVersion, status: "PROCESSING" },
    data: progress,
  });

  return NextResponse.json({ accepted: result.count === 1 });
}
