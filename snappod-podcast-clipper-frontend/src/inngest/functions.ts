import { env } from "~/env";
import { inngest } from "./client";
import { db } from "~/server/db";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const processVideo = inngest.createFunction(
  {
    id: "process-video",
    retries: 1,
    concurrency: {
      limit: 1,
      key: "event.data.userId",
    },
  },
  { event: "process-video-events" },
  async ({ event, step }) => {
    const { uploadedFileId } = event.data as {
      uploadedFileId: string;
      userId: string;
    };

    try {
      const { userId, credits, s3Key, requestedClipCount, processingVersion } =
        await step.run("check-credits", async () => {
          const uploadedFile = await db.uploadedFile.findUniqueOrThrow({
            where: {
              id: uploadedFileId,
            },
            select: {
              user: {
                select: {
                  id: true,
                  credits: true,
                },
              },
              s3Key: true,
              requestedClipCount: true,
              processingVersion: true,
            },
          });

          return {
            userId: uploadedFile.user.id,
            credits: uploadedFile.user.credits,
            s3Key: uploadedFile.s3Key,
            requestedClipCount: uploadedFile.requestedClipCount,
            processingVersion: uploadedFile.processingVersion,
          };
        });

      if (credits > 0) {
        await step.run("start-processing", async () => {
          await db.uploadedFile.update({
            where: { id: uploadedFileId },
            data: {
              status: "PROCESSING",
              processingStage: "PREPARING_VIDEO",
              progressPercent: 5,
              processedClipCount: 0,
              errorCode: null,
              errorMessage: null,
            },
          });
        });

        const processingResponse = await step.fetch(
          env.PROCESS_VIDEO_ENDPOINT,
          {
            method: "POST",
            body: JSON.stringify({
              s3_key: s3Key,
              project_id: uploadedFileId,
              processing_version: processingVersion,
              progress_callback_url: env.PROCESSING_PROGRESS_CALLBACK_URL,
              requested_clip_count: Math.min(requestedClipCount, credits),
            }),
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${env.PROCESS_VIDEO_ENDPOINT_AUTH}`,
            },
          },
        );
        if (!processingResponse.ok)
          throw new Error(`Processor returned ${processingResponse.status}`);

        const processorResult = (await processingResponse.json()) as {
          requested_clip_count: number;
          candidates_found: number;
          valid_candidate_count: number;
          successful_keys: string[];
          failed_clip_count: number;
        };

        const { clipsFound } = await step.run(
          "create-clips-in-db",
          async () => {
            await db.uploadedFile.update({
              where: { id: uploadedFileId },
              data: { processingStage: "FINALIZING", progressPercent: 97 },
            });

            const projectPrefix = `users/${userId}/projects/${uploadedFileId}/renders/`;
            const candidateKeys = processorResult.successful_keys.filter(
              (key) => key.startsWith(projectPrefix),
            );
            const clipKeys = await verifyS3Objects(candidateKeys);

            if (clipKeys.length > 0) {
              await db.$transaction(
                clipKeys.map((clipKey) =>
                  db.clip.upsert({
                    where: {
                      uploadedFileId_s3Key: { uploadedFileId, s3Key: clipKey },
                    },
                    create: { s3Key: clipKey, uploadedFileId, userId },
                    update: {
                      processingStatus: "COMPLETED",
                      errorCode: null,
                      errorMessage: null,
                    },
                  }),
                ),
              );
            }

            return { clipsFound: clipKeys.length };
          },
        );

        await step.run("deduct-credits", async () => {
          await db.user.update({
            where: {
              id: userId,
            },
            data: {
              credits: {
                decrement: Math.min(credits, clipsFound),
              },
            },
          });
        });

        await step.run("set-terminal-status", async () => {
          const partial =
            clipsFound > 0 && clipsFound < processorResult.requested_clip_count;
          const failed = clipsFound === 0;
          const fewerMoments =
            processorResult.valid_candidate_count <
            processorResult.requested_clip_count;
          await db.uploadedFile.update({
            where: {
              id: uploadedFileId,
            },
            data: {
              status: failed
                ? "FAILED"
                : partial
                  ? "PARTIALLY_COMPLETED"
                  : "COMPLETED",
              processingStage: "FINALIZING",
              progressPercent: 100,
              processedClipCount: clipsFound,
              requestedClipCount: processorResult.requested_clip_count,
              errorCode: failed
                ? "NO_USABLE_CLIPS"
                : partial
                  ? "CLIP_RENDER_FAILED"
                  : null,
              errorMessage: failed
                ? processorResult.candidates_found === 0
                  ? "No strong, self-contained moments were found in this video."
                  : "No usable clips could be created. Please retry processing."
                : partial
                  ? fewerMoments && processorResult.failed_clip_count === 0
                    ? `${clipsFound} strong moments were found and are ready to download.`
                    : `${clipsFound} of ${processorResult.requested_clip_count} clips are ready to download.`
                  : null,
            },
          });
        });
      } else {
        await step.run("set-status-no-credits", async () => {
          await db.uploadedFile.update({
            where: {
              id: uploadedFileId,
            },
            data: {
              status: "FAILED",
              errorCode: "NO_CREDITS",
              errorMessage: "No processing allowance remains for this account.",
            },
          });
        });
      }
    } catch {
      await db.uploadedFile.update({
        where: {
          id: uploadedFileId,
        },
        data: {
          status: "FAILED",
          errorCode: "PROCESSING_FAILED",
          errorMessage: "SnapPod could not finish this video. Please retry.",
        },
      });
    }
  },
);

async function verifyS3Objects(keys: string[]) {
  const s3Client = new S3Client({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });

  const checks = await Promise.all(
    keys.map(async (key) => {
      try {
        await s3Client.send(
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
