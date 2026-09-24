CREATE TYPE "ProcessingJobStatus" AS ENUM ('QUEUED', 'DISPATCHED', 'PROCESSING', 'FINALIZING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED');

CREATE TABLE "ProcessingJob" (
    "id" TEXT NOT NULL,
    "status" "ProcessingJobStatus" NOT NULL DEFAULT 'QUEUED',
    "processingStage" "ProcessingStage",
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "requestedClipCount" INTEGER NOT NULL,
    "processedClipCount" INTEGER NOT NULL DEFAULT 0,
    "reservedCredits" INTEGER NOT NULL,
    "processingVersion" INTEGER NOT NULL,
    "externalJobId" TEXT,
    "candidatesFound" INTEGER,
    "validCandidateCount" INTEGER,
    "failedClipCount" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "uploadedFileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProcessingJob_uploadedFileId_processingVersion_key" ON "ProcessingJob"("uploadedFileId", "processingVersion");
CREATE INDEX "ProcessingJob_status_createdAt_idx" ON "ProcessingJob"("status", "createdAt");
CREATE INDEX "ProcessingJob_userId_status_idx" ON "ProcessingJob"("userId", "status");

ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_uploadedFileId_fkey" FOREIGN KEY ("uploadedFileId") REFERENCES "UploadedFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
