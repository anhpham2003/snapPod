"use server";

import { auth } from "~/server/auth";
import { redirect } from "next/navigation";
import { db } from "~/server/db";
import { DashboardClient } from "~/components/dashboard-client";

export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const userData = await db.user.findUniqueOrThrow({
    where: { id: session.user.id },
    select: {
      uploadedFiles: {
        where: {
          uploaded: true,
        },
        select: {
          id: true,
          s3Key: true,
          displayName: true,
          status: true,
          processingStage: true,
          progressPercent: true,
          processedClipCount: true,
          requestedClipCount: true,
          errorCode: true,
          errorMessage: true,
          createdAt: true,
          _count: {
            select: {
              clips: true,
            },
          },
        },
      },
      clips: {
        orderBy: {
          createdAt: "desc",
        },
      },
    },
  });

  const formattedFiles = userData.uploadedFiles.map((file) => ({
    id: file.id,
    s3Key: file.s3Key,
    filename:
      file.displayName && file.displayName.length > 0
        ? file.displayName
        : "Unknown file name",
    status: file.status,
    processingStage: file.processingStage,
    progressPercent: file.progressPercent,
    processedClipCount: file.processedClipCount,
    requestedClipCount: file.requestedClipCount,
    errorCode: file.errorCode,
    errorMessage: file.errorMessage,
    clipsCount: file._count.clips,
    createdAt: file.createdAt,
  }));

  return (
    <DashboardClient uploadedFiles={formattedFiles} clips={userData.clips} />
  );
}
