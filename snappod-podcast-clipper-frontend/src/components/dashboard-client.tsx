"use client";

import type { Clip, ProcessingStage, ProjectStatus } from "@prisma/client";
import { AlertCircle, Check, Circle, Loader2, UploadCloud } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { processVideo, retryVideo } from "~/actions/generation";
import { generateUploadUrl } from "~/actions/s3";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { ClipDisplay } from "./clip-display";
import Dropzone, {
  type DropzoneState,
} from "./vendor/shadcn-dropzon";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

const stages: {
  value: ProcessingStage;
  short: string;
  title: string;
  description: string;
}[] = [
  {
    value: "PREPARING_VIDEO",
    short: "Processing video",
    title: "Processing your video",
    description: "We’re validating and preparing the source video.",
  },
  {
    value: "TRANSCRIBING",
    short: "Understanding conversation",
    title: "Understanding the conversation",
    description: "We’re transcribing the audio and aligning the dialogue.",
  },
  {
    value: "IDENTIFYING_MOMENTS",
    short: "Identifying key moments",
    title: "Identifying key moments",
    description: "We’re finding and ranking the strongest moments.",
  },
  {
    value: "CREATING_CLIPS",
    short: "Creating short clips",
    title: "Creating your short clips",
    description: "We’re extracting the requested moments into short videos.",
  },
  {
    value: "ADDING_CAPTIONS",
    short: "Adding captions",
    title: "Adding captions",
    description: "We’re synchronizing and styling captions for each clip.",
  },
  {
    value: "FINALIZING",
    short: "Wrapping up",
    title: "Wrapping up",
    description: "We’re verifying and securely saving your finished clips.",
  },
];

type UploadedFile = {
  id: string;
  s3Key: string;
  filename: string;
  status: ProjectStatus;
  processingStage: ProcessingStage | null;
  progressPercent: number;
  processedClipCount: number;
  requestedClipCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  clipsCount: number;
  createdAt: Date;
};
const terminal = new Set<ProjectStatus>([
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "FAILED",
]);

function ProjectProgress({
  project,
  onRetry,
  retrying,
}: {
  project: UploadedFile;
  onRetry: (projectId: string) => void;
  retrying: boolean;
}) {
  const index = project.processingStage
    ? stages.findIndex((stage) => stage.value === project.processingStage)
    : -1;
  const current = index >= 0 ? stages[index] : null;
  const failed = project.status === "FAILED";
  const partial = project.status === "PARTIALLY_COMPLETED";
  const complete = project.status === "COMPLETED";
  const title = complete
    ? "Clips ready"
    : partial
      ? "Some clips are ready"
      : failed
        ? "Processing failed"
        : project.status === "QUEUED"
          ? "Waiting to start"
          : (current?.title ?? "Processing");
  const description = complete
    ? "Your clips are ready to preview and download."
    : partial
      ? `${project.processedClipCount} of ${project.requestedClipCount} clips are ready. You can preview and download every completed clip.`
      : failed
        ? (project.errorMessage ??
          "SnapPod could not finish this video. Retry it or upload another video.")
        : project.status === "QUEUED"
          ? "Your video has been added to the processing queue."
          : current?.description;

  return (
    <div className="space-y-3 py-2">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium">{title}</p>
          <p className="text-muted-foreground text-sm">{description}</p>
          {project.status === "PROCESSING" &&
            project.requestedClipCount > 0 &&
            index >= 3 && (
              <p className="mt-1 text-sm">
                {project.processedClipCount} of {project.requestedClipCount}{" "}
                clips processed
              </p>
            )}
        </div>
        <Badge variant={failed ? "destructive" : "outline"}>
          {project.progressPercent}%
        </Badge>
      </div>
      <div
        className="bg-muted h-2 overflow-hidden rounded-full"
        aria-label={`${project.progressPercent}% complete`}
      >
        <div
          className="bg-primary h-full transition-[width] duration-500"
          style={{ width: `${project.progressPercent}%` }}
        />
      </div>
      <div className="sm:hidden">
        <p className="text-sm font-medium">
          {complete ? "Clips ready" : (current?.short ?? title)}
        </p>
        {!complete && index >= 0 && (
          <p className="text-muted-foreground text-xs">
            Step {index + 1} of {stages.length}
          </p>
        )}
      </div>
      <ol
        className="hidden grid-cols-8 gap-2 sm:grid"
        aria-label="Processing steps"
      >
        <li className="flex min-w-0 flex-col gap-1 text-xs">
          <Check className="h-4 w-4" aria-label="Completed" />
          <span>Upload complete</span>
        </li>
        {stages.map((stage, stageIndex) => {
          const done = complete || partial || stageIndex < index;
          const active =
            !failed && !complete && !partial && stageIndex === index;
          const failedHere = failed && stageIndex === index;
          return (
            <li
              key={stage.value}
              className={`flex min-w-0 flex-col gap-1 text-xs ${stageIndex > index && !complete && !partial ? "text-muted-foreground" : ""}`}
            >
              {done ? (
                <Check className="h-4 w-4" aria-label="Completed" />
              ) : failedHere ? (
                <AlertCircle
                  className="text-destructive h-4 w-4"
                  aria-label="Failed"
                />
              ) : active ? (
                <Loader2
                  className="h-4 w-4 animate-spin"
                  aria-label="In progress"
                />
              ) : (
                <Circle className="h-4 w-4" aria-label="Not started" />
              )}
              <span>{stage.short}</span>
            </li>
          );
        })}
        <li
          className={`flex min-w-0 flex-col gap-1 text-xs ${complete || partial ? "" : "text-muted-foreground"}`}
        >
          {complete || partial ? (
            <Check className="h-4 w-4" aria-label="Completed" />
          ) : (
            <Circle className="h-4 w-4" aria-label="Not started" />
          )}
          <span>Clips ready</span>
        </li>
      </ol>
      {!terminal.has(project.status) && (
        <p className="text-muted-foreground text-xs">
          Processing continues safely if you close this page.
        </p>
      )}
      {failed && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={retrying}
          onClick={() => onRetry(project.id)}
        >
          {retrying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Retry processing
        </Button>
      )}
    </div>
  );
}

export function DashboardClient({
  uploadedFiles,
  clips,
}: {
  uploadedFiles: UploadedFile[];
  clips: Clip[];
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [requestedClipCount, setRequestedClipCount] = useState<1 | 3 | 5>(3);
  const [retryingProjectId, setRetryingProjectId] = useState<string | null>(
    null,
  );
  const [refreshing, startRefresh] = useTransition();
  const router = useRouter();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasActiveProject = uploadedFiles.some(
    (file) => !terminal.has(file.status),
  );
  const refresh = useCallback(() => {
    startRefresh(() => router.refresh());
  }, [router]);

  useEffect(() => {
    if (!hasActiveProject) return;
    const schedule = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      if (!document.hidden) refreshTimer.current = setTimeout(refresh, 3000);
    };
    const onVisibility = () => {
      if (document.hidden) {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
      } else refresh();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [hasActiveProject, refresh]);

  const handleUpload = async () => {
    if (!files[0]) return;
    setUploading(true);
    try {
      const file = files[0];
      const result = await generateUploadUrl({
        filename: file.name,
        contentType: file.type,
        requestedClipCount,
      });
      if (!result.success) throw new Error(result.error);
      const response = await fetch(result.signedUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!response.ok)
        throw new Error(`Upload failed with status ${response.status}`);
      const processingResult = await processVideo(result.uploadedFileId);
      if (!processingResult.success) throw new Error(processingResult.error);
      setFiles([]);
      toast.success("Video uploaded", {
        description:
          "Processing has started and continues if you leave this page.",
      });
      refresh();
    } catch {
      toast.error("Upload failed", {
        description:
          "There was a problem uploading your video. Please try again.",
      });
      setUploading(false);
    }
  };

  const handleRetry = async (projectId: string) => {
    setRetryingProjectId(projectId);
    try {
      const result = await retryVideo(projectId);
      if (!result.success) throw new Error(result.error);
      toast.success("Processing restarted");
      refresh();
    } catch {
      toast.error("Retry failed", {
        description: "SnapPod could not restart this video. Please try again.",
      });
    } finally {
      setRetryingProjectId(null);
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col space-y-6 px-4 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Podcast Clipper
          </h1>
          <p className="text-muted-foreground">
            Upload your podcast and get AI-generated clips
          </p>
        </div>
      </div>
      <Tabs defaultValue="upload">
        <TabsList>
          <TabsTrigger value="upload">Uploads</TabsTrigger>
          <TabsTrigger value="my-clips">My Clips</TabsTrigger>
        </TabsList>
        <TabsContent value="upload">
          <Card>
            <CardHeader>
              <CardTitle>Upload Video</CardTitle>
              <CardDescription>
                Upload an MP4 or MOV video to generate clips
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <Dropzone
                onDrop={setFiles}
                accept={{ "video/mp4": [".mp4"], "video/quicktime": [".mov"] }}
                maxSize={500 * 1024 * 1024}
                disabled={uploading}
                maxFiles={1}
              >
                {(_dropzone: DropzoneState) => (
                  <div className="flex flex-col items-center justify-center space-y-4 rounded-lg p-10 text-center">
                    <UploadCloud className="text-muted-foreground h-12 w-12" />
                    <p className="font-medium">Drag and drop your file</p>
                    <p className="text-muted-foreground text-sm">
                      or click to browse (MP4 or MOV up to 500MB)
                    </p>
                    <Button size="sm" disabled={uploading}>
                      Select File
                    </Button>
                  </div>
                )}
              </Dropzone>
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-3">
                  {files[0] && (
                    <>
                      <p className="text-sm font-medium">Selected file:</p>
                      <p className="text-muted-foreground text-sm">
                        {files[0].name}
                      </p>
                    </>
                  )}
                  <label
                    className="block text-sm font-medium"
                    htmlFor="clip-count"
                  >
                    Number of clips
                  </label>
                  <select
                    id="clip-count"
                    value={requestedClipCount}
                    onChange={(event) =>
                      setRequestedClipCount(
                        Number(event.target.value) as 1 | 3 | 5,
                      )
                    }
                    disabled={uploading}
                    className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                  >
                    <option value={1}>1 clip</option>
                    <option value={3}>3 clips</option>
                    <option value={5}>5 clips</option>
                  </select>
                </div>
                <Button
                  disabled={!files[0] || uploading}
                  onClick={handleUpload}
                >
                  {uploading && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {uploading ? "Uploading…" : "Upload and generate clips"}
                </Button>
              </div>
              {uploadedFiles.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-medium">Processing status</h3>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={refresh}
                      disabled={refreshing}
                    >
                      {refreshing && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      Refresh
                    </Button>
                  </div>
                  {uploadedFiles.map((project) => (
                    <div key={project.id} className="rounded-md border p-4">
                      <div className="flex items-center justify-between gap-4">
                        <p className="max-w-xs truncate font-medium">
                          {project.filename}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {new Date(project.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <ProjectProgress
                        project={project}
                        onRetry={handleRetry}
                        retrying={retryingProjectId === project.id}
                      />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="my-clips">
          <Card>
            <CardHeader>
              <CardTitle>My Clips</CardTitle>
              <CardDescription>
                View and manage your generated clips.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ClipDisplay clips={clips} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
