import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "~/env";
import { hasValidProcessorToken } from "~/server/callback-auth";
import { db } from "~/server/db";

const payloadSchema = z.object({
  projectId: z.string().min(1),
  jobId: z.string().min(1),
  processingVersion: z.number().int().positive(),
  requested_clip_count: z.number().int().min(1).max(5),
  candidates_found: z.number().int().min(0),
  valid_candidate_count: z.number().int().min(0),
  successful_keys: z.array(z.string().min(1)).max(5),
  failed_clip_count: z.number().int().min(0),
  error_code: z.string().max(100).nullable().optional(),
  error_message: z.string().max(500).nullable().optional(),
});

const terminalStatuses = [
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "FAILED",
] as const;

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
      { error: "Invalid completion payload" },
      { status: 400 },
    );
  }

  const payload = parsed.data;
  const job = await db.processingJob.findFirst({
    where: {
      id: payload.jobId,
      uploadedFileId: payload.projectId,
      processingVersion: payload.processingVersion,
    },
    select: {
      id: true,
      userId: true,
      uploadedFileId: true,
      processingVersion: true,
      requestedClipCount: true,
      reservedCredits: true,
      status: true,
    },
  });
  if (!job) {
    return NextResponse.json({ error: "Processing job not found" }, { status: 404 });
  }
  if (terminalStatuses.includes(job.status as (typeof terminalStatuses)[number])) {
    return NextResponse.json({ accepted: true, duplicate: true });
  }

  const projectPrefix = `users/${job.userId}/projects/${job.uploadedFileId}/renders/`;
  const candidateKeys = payload.successful_keys
    .filter((key) => key.startsWith(projectPrefix))
    .slice(0, job.requestedClipCount);
  const verifiedKeys = await verifyS3Objects(candidateKeys);
  const clipsFound = verifiedKeys.length;
  const workerFailed = Boolean(payload.error_code);
  const failed = workerFailed || clipsFound === 0;
  const partial = !failed && clipsFound < job.requestedClipCount;
  const terminalStatus = failed
    ? "FAILED"
    : partial
      ? "PARTIALLY_COMPLETED"
      : "COMPLETED";
  const fewerMoments =
    payload.valid_candidate_count < job.requestedClipCount &&
    payload.failed_clip_count === 0;
  const errorCode = failed
    ? (payload.error_code ?? "NO_USABLE_CLIPS")
    : partial
      ? fewerMoments
        ? "FEWER_MOMENTS_FOUND"
        : "CLIP_RENDER_FAILED"
      : null;
  const errorMessage = failed
    ? (payload.error_message ??
      (payload.candidates_found === 0
        ? "No strong, self-contained moments were found in this video."
        : "No usable clips could be created. Please retry processing."))
    : partial
      ? fewerMoments
        ? `${clipsFound} strong moments were found and are ready to download.`
        : `${clipsFound} of ${job.requestedClipCount} clips are ready to download.`
      : null;

  const finalized = await db.$transaction(async (tx) => {
    const claim = await tx.processingJob.updateMany({
      where: {
        id: job.id,
        status: { in: ["QUEUED", "DISPATCHED", "PROCESSING"] },
      },
      data: { status: "FINALIZING", processingStage: "FINALIZING" },
    });
    if (claim.count !== 1) return false;

    for (const s3Key of verifiedKeys) {
      await tx.clip.upsert({
        where: {
          uploadedFileId_s3Key: {
            uploadedFileId: job.uploadedFileId,
            s3Key,
          },
        },
        create: {
          s3Key,
          uploadedFileId: job.uploadedFileId,
          userId: job.userId,
        },
        update: {
          processingStatus: "COMPLETED",
          errorCode: null,
          errorMessage: null,
        },
      });
    }

    const refund = Math.max(job.reservedCredits - clipsFound, 0);
    if (refund > 0) {
      await tx.user.update({
        where: { id: job.userId },
        data: { credits: { increment: refund } },
      });
    }

    await tx.processingJob.update({
      where: { id: job.id },
      data: {
        status: terminalStatus,
        progressPercent: 100,
        processedClipCount: clipsFound,
        candidatesFound: payload.candidates_found,
        validCandidateCount: payload.valid_candidate_count,
        failedClipCount: payload.failed_clip_count,
        errorCode,
        errorMessage,
        heartbeatAt: new Date(),
        completedAt: new Date(),
      },
    });
    await tx.uploadedFile.updateMany({
      where: {
        id: job.uploadedFileId,
        processingVersion: job.processingVersion,
      },
      data: {
        status: terminalStatus,
        processingStage: "FINALIZING",
        progressPercent: 100,
        processedClipCount: clipsFound,
        errorCode,
        errorMessage,
      },
    });
    return true;
  });

  return NextResponse.json({ accepted: finalized, duplicate: !finalized });
}

async function verifyS3Objects(keys: string[]) {
  const client = new S3Client({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
  const checks = await Promise.all(
    keys.map(async (key) => {
      try {
        await client.send(
          new HeadObjectCommand({ Bucket: env.S3_BUCKET_NAME, Key: key }),
        );
        return key;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((key): key is string => key !== null);
}
