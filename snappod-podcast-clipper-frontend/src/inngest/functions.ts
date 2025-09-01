import { inngest } from "./client";
import { env } from "~/env";
import { db } from "~/server/db";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

export const processVideo = inngest.createFunction(
  { id: "process-video",
    retries: 1, 
    concurrency: {
    limit: 1,
    key: "event.data.userId",
    }, 
},
  { event: "process-video-events" },
  async ({ event, step }) => {
    const {uploadedFileId} = event.data;

    const {userId, credits, s3_Key} = await step.run("check-credits", async () => {
      const uploadedFile = await db.uploadedFile.findUniqueOrThrow({
        where: {
          id: uploadedFileId
        },
        select: {
          user: {
            select: {
              id: true,
              credits: true,
            },
          },
          s3Key: true,
        },
      });
      return {
        userId: uploadedFile.user.id, 
        credits: uploadedFile.user.credits,
        s3_Key: uploadedFileId.s3Key,
      };
    });

    if (credits > 0) {
      await step.run("set-stats-processing", async () => {
        await db.uploadedFile.update({
          where: {
            id: uploadedFileId,
          },
          data: {
            status: "processing",
          },
        });
      });

      await step.run("call-modal-endpoint", async () => {
          await fetch(env.PROCESS_VIDEO_ENDPOINT, {
              method: "POST",
              body: JSON.stringify({ s3_key: s3_Key }),
              headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${env.PROCESS_VIDEO_ENDPOINT_AUTH}`,
              },
          });
      });

      const { clipsFound } = await step.run("create-clips-in-db", async () => {
        const folderPrefix = s3_Key.split("/")[0]!;

        const allKeys = await listS3ObjectsByPrefix(folderPrefix);

        const clipKeys = allKeys.filter(
          (key): key is string =>
            key !== undefined && !key.endsWith("original.mp4"),
        );

        if (clipKeys.length > 0) {
          await db.clip.createMany({
            data: clipKeys.map((clipKey) => ({
              s3Key: clipKey,
              uploadedFileId,
              userId,
            }))
          });
        }

        return {clipsFound: clipKeys.length}
      });

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

      await step.run("set-stats-processed", async () => {
        await db.uploadedFile.update({
          where: {
            id: uploadedFileId,
          },
          data: {
            status: "processed",
          },
        });
      });
    } else {
      await step.run("set-stats-no-credits", async () => {
        await db.uploadedFile.update({
          where: {
            id: uploadedFileId,
          },
          data: {
            status: "no credits",
          },
        });
      });
    }
  },
);

async function listS3ObjectsByPrefix(prefix: string) {
  const s3Client = new S3Client({
    region: env.AWS_REGION,
    credentials: {
    accessKeyId: env.AWS_ACCCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });

  const listCommand = new ListObjectsV2Command({
    Bucket: env.S3_BUCKET_NAME,
    Prefix: prefix
  });

  const response = await s3Client.send(listCommand)
  return response.Contents?.map((item) => item.Key).filter(Boolean) || [];
}