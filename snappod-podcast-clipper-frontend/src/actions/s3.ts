"use server";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { env } from "~/env";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

const uploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.enum(["video/mp4", "video/quicktime"]),
  requestedClipCount: z.union([z.literal(1), z.literal(3), z.literal(5)]),
});

type UploadResult =
  | { success: true; signedUrl: string; key: string; uploadedFileId: string }
  | { success: false; error: string };

export async function generateUploadUrl(input: {
  filename: string;
  contentType: string;
  requestedClipCount: number;
}): Promise<UploadResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = uploadSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Choose a valid MP4 or MOV video." };
  }

  const project = await db.uploadedFile.create({
    data: {
      userId: session.user.id,
      s3Key: "pending",
      displayName: parsed.data.filename,
      requestedClipCount: parsed.data.requestedClipCount,
    },
    select: { id: true },
  });
  const extension =
    parsed.data.contentType === "video/quicktime" ? "mov" : "mp4";
  const key = `users/${session.user.id}/projects/${project.id}/source/original.${extension}`;

  try {
    const client = new S3Client({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
    const signedUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: env.S3_BUCKET_NAME,
        Key: key,
        ContentType: parsed.data.contentType,
      }),
      { expiresIn: 600 },
    );
    await db.uploadedFile.update({
      where: { id: project.id },
      data: { s3Key: key },
    });
    return { success: true, signedUrl, key, uploadedFileId: project.id };
  } catch {
    await db.uploadedFile.delete({ where: { id: project.id } });
    return { success: false, error: "Could not prepare the upload." };
  }
}
