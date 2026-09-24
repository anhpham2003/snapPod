"use server";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { env } from "~/env";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

type ActionResult = { success: true } | { success: false; error: string };

type Reservation = {
  jobId: string;
  projectId: string;
  userId: string;
  s3Key: string;
  processingVersion: number;
  requestedClipCount: number;
};

const dispatchResponseSchema = z.object({
  accepted: z.literal(true),
  external_job_id: z.string().min(1),
});

export async function processVideo(
  uploadedFileId: string,
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const reservation = await reserveProcessingJob(
    uploadedFileId,
    session.user.id,
    false,
  );
  if (!reservation.success) return reservation;
  return dispatchProcessingJob(reservation.job);
}

export async function retryVideo(
  uploadedFileId: string,
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const reservation = await reserveProcessingJob(
    uploadedFileId,
    session.user.id,
    true,
  );
  if (!reservation.success) return reservation;
  return dispatchProcessingJob(reservation.job);
}

async function reserveProcessingJob(
  uploadedFileId: string,
  userId: string,
  retry: boolean,
): Promise<
  | { success: true; job: Reservation }
  | { success: false; error: string }
> {
  try {
    return await db.$transaction(
      async (tx) => {
        const project = await tx.uploadedFile.findFirst({
          where: {
            id: uploadedFileId,
            userId,
            ...(retry
              ? { status: "FAILED" as const }
              : { status: "QUEUED" as const, uploaded: false }),
          },
          select: {
            id: true,
            userId: true,
            s3Key: true,
            requestedClipCount: true,
            processingVersion: true,
            user: { select: { credits: true } },
          },
        });
        if (!project) {
          return {
            success: false as const,
            error: retry
              ? "This video cannot be retried."
              : "This video is already processing.",
          };
        }

        const requestedClipCount = Math.min(
          project.requestedClipCount,
          project.user.credits,
        );
        if (requestedClipCount < 1) {
          return {
            success: false as const,
            error: "No processing allowance remains for this account.",
          };
        }
        const processingVersion = retry
          ? project.processingVersion + 1
          : project.processingVersion;

        const projectClaim = await tx.uploadedFile.updateMany({
          where: {
            id: project.id,
            userId,
            processingVersion: project.processingVersion,
            ...(retry
              ? { status: "FAILED" as const }
              : { status: "QUEUED" as const, uploaded: false }),
          },
          data: {
            uploaded: true,
            status: "QUEUED",
            processingStage: null,
            progressPercent: 0,
            processedClipCount: 0,
            requestedClipCount,
            processingVersion,
            errorCode: null,
            errorMessage: null,
          },
        });
        if (projectClaim.count !== 1) {
          return {
            success: false as const,
            error: "This video is already processing.",
          };
        }

        const creditClaim = await tx.user.updateMany({
          where: { id: userId, credits: { gte: requestedClipCount } },
          data: { credits: { decrement: requestedClipCount } },
        });
        if (creditClaim.count !== 1) {
          throw new Error("CREDIT_RESERVATION_FAILED");
        }

        const job = await tx.processingJob.create({
          data: {
            uploadedFileId: project.id,
            userId,
            requestedClipCount,
            reservedCredits: requestedClipCount,
            processingVersion,
          },
          select: { id: true },
        });

        return {
          success: true as const,
          job: {
            jobId: job.id,
            projectId: project.id,
            userId,
            s3Key: project.s3Key,
            processingVersion,
            requestedClipCount,
          },
        };
      },
      { isolationLevel: "Serializable" },
    );
  } catch {
    return {
      success: false,
      error: "SnapPod could not reserve processing capacity. Please try again.",
    };
  }
}

async function dispatchProcessingJob(job: Reservation): Promise<ActionResult> {
  const dispatch = await requestModalDispatch(job);
  if (dispatch.kind === "rejected") {
    const released = await releaseDispatchReservation(job);
    if (!released) {
      revalidatePath("/dashboard");
      return { success: true };
    }
    return { success: false, error: "Could not schedule video processing." };
  }

  try {
    await db.$transaction([
      db.processingJob.updateMany({
        where: { id: job.jobId, status: "QUEUED" },
        data: {
          status: "DISPATCHED",
          externalJobId:
            dispatch.kind === "accepted" ? dispatch.externalJobId : null,
          startedAt: new Date(),
          heartbeatAt: new Date(),
          errorCode:
            dispatch.kind === "uncertain"
              ? "DISPATCH_CONFIRMATION_LOST"
              : null,
        },
      }),
      db.uploadedFile.updateMany({
        where: {
          id: job.projectId,
          processingVersion: job.processingVersion,
          status: "QUEUED",
        },
        data: {
          status: "PROCESSING",
          processingStage: "PREPARING_VIDEO",
          progressPercent: 5,
        },
      }),
    ]);
  } catch {
    // Modal owns the durable call now. Its progress or completion callback can
    // still advance the queued database record after a transient DB failure.
  }
  revalidatePath("/dashboard");
  return { success: true };
}

async function requestModalDispatch(job: Reservation): Promise<
  | { kind: "accepted"; externalJobId: string }
  | { kind: "rejected" }
  | { kind: "uncertain" }
> {
  const body = JSON.stringify({
    s3_key: job.s3Key,
    project_id: job.projectId,
    job_id: job.jobId,
    processing_version: job.processingVersion,
    progress_callback_url: env.PROCESSING_PROGRESS_CALLBACK_URL,
    completion_callback_url: env.PROCESSING_COMPLETION_CALLBACK_URL,
    requested_clip_count: job.requestedClipCount,
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(env.PROCESS_VIDEO_ENDPOINT, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.PROCESS_VIDEO_ENDPOINT_AUTH}`,
        },
        cache: "no-store",
      });
      if (response.ok) {
        const parsed = dispatchResponseSchema.safeParse(await response.json());
        return parsed.success
          ? { kind: "accepted", externalJobId: parsed.data.external_job_id }
          : { kind: "uncertain" };
      }
      if (response.status >= 400 && response.status < 500) {
        return { kind: "rejected" };
      }
    } catch {
      // A lost response is safe to retry because the Modal enqueue endpoint
      // deduplicates requests by the durable processing job ID.
    }
  }
  return { kind: "uncertain" };
}

async function releaseDispatchReservation(job: Reservation) {
  return db.$transaction(
    async (tx) => {
      const claim = await tx.processingJob.updateMany({
        where: { id: job.jobId, status: "QUEUED" },
        data: {
          status: "FAILED",
          errorCode: "DISPATCH_FAILED",
          errorMessage: "SnapPod could not start this processing job.",
          completedAt: new Date(),
        },
      });
      if (claim.count !== 1) return false;

      await tx.user.update({
        where: { id: job.userId },
        data: { credits: { increment: job.requestedClipCount } },
      });
      await tx.uploadedFile.updateMany({
        where: {
          id: job.projectId,
          processingVersion: job.processingVersion,
        },
        data: {
          status: "FAILED",
          errorCode: "DISPATCH_FAILED",
          errorMessage: "SnapPod could not start this processing job.",
        },
      });
      return true;
    },
    { isolationLevel: "Serializable" },
  );
}

function createS3Client() {
  return new S3Client({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

async function findOwnedClip(clipId: string) {
  const session = await auth();
  if (!session?.user?.id) return null;
  return db.clip.findFirst({
    where: { id: clipId, userId: session.user.id },
    select: { id: true, s3Key: true },
  });
}

export async function getClipPlayUrl(
  clipId: string,
): Promise<{ success: boolean; url?: string; error?: string }> {
  const clip = await findOwnedClip(clipId);
  if (!clip) return { success: false, error: "Clip not found." };
  try {
    const url = await getSignedUrl(
      createS3Client(),
      new GetObjectCommand({ Bucket: env.S3_BUCKET_NAME, Key: clip.s3Key }),
      { expiresIn: 3600 },
    );
    return { success: true, url };
  } catch {
    return { success: false, error: "Failed to generate playback URL." };
  }
}

export async function getClipDownloadUrl(clipId: string): Promise<{
  success: boolean;
  url?: string;
  filename?: string;
  error?: string;
}> {
  const clip = await findOwnedClip(clipId);
  if (!clip) return { success: false, error: "Clip not found." };
  const filename = `snappod-${clip.id}.mp4`;
  try {
    const url = await getSignedUrl(
      createS3Client(),
      new GetObjectCommand({
        Bucket: env.S3_BUCKET_NAME,
        Key: clip.s3Key,
        ResponseContentDisposition: `attachment; filename="${filename}"`,
      }),
      { expiresIn: 600 },
    );
    return { success: true, url, filename };
  } catch {
    return { success: false, error: "Failed to prepare the download." };
  }
}
