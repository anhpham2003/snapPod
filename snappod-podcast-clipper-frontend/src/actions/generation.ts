"use server";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { revalidatePath } from "next/cache";
import { env } from "~/env";
import { inngest } from "~/inngest/client";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

type ActionResult = { success: true } | { success: false; error: string };

export async function processVideo(
  uploadedFileId: string,
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const claimed = await db.uploadedFile.updateMany({
    where: {
      id: uploadedFileId,
      userId: session.user.id,
      uploaded: false,
      status: "QUEUED",
    },
    data: { uploaded: true },
  });
  if (claimed.count !== 1) {
    return { success: false, error: "This video is already processing." };
  }

  const project = await db.uploadedFile.findFirst({
    where: { id: uploadedFileId, userId: session.user.id },
    select: { id: true, userId: true, processingVersion: true },
  });
  if (!project) return { success: false, error: "Video not found." };

  try {
    await inngest.send({
      id: `process-${project.id}-v${project.processingVersion}`,
      name: "process-video-events",
      data: { uploadedFileId: project.id, userId: project.userId },
    });
  } catch {
    await db.uploadedFile.updateMany({
      where: { id: project.id, userId: project.userId, status: "QUEUED" },
      data: { uploaded: false },
    });
    return { success: false, error: "Could not schedule video processing." };
  }

  revalidatePath("/dashboard");
  return { success: true };
}

export async function retryVideo(
  uploadedFileId: string,
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const reset = await db.uploadedFile.updateMany({
    where: {
      id: uploadedFileId,
      userId: session.user.id,
      status: "FAILED",
    },
    data: {
      status: "QUEUED",
      processingStage: null,
      progressPercent: 0,
      processedClipCount: 0,
      errorCode: null,
      errorMessage: null,
      processingVersion: { increment: 1 },
    },
  });
  if (reset.count !== 1) {
    return { success: false, error: "This video cannot be retried." };
  }

  const project = await db.uploadedFile.findFirst({
    where: { id: uploadedFileId, userId: session.user.id },
    select: { id: true, userId: true, processingVersion: true },
  });
  if (!project) return { success: false, error: "Video not found." };

  try {
    await inngest.send({
      id: `process-${project.id}-v${project.processingVersion}`,
      name: "process-video-events",
      data: { uploadedFileId: project.id, userId: project.userId },
    });
    revalidatePath("/dashboard");
    return { success: true };
  } catch {
    await db.uploadedFile.update({
      where: { id: project.id },
      data: {
        status: "FAILED",
        errorCode: "SCHEDULING_FAILED",
        errorMessage: "SnapPod could not schedule this retry. Try again.",
      },
    });
    return { success: false, error: "Could not schedule the retry." };
  }
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
