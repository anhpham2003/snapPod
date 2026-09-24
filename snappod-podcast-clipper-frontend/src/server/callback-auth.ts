import { timingSafeEqual } from "node:crypto";
import { env } from "~/env";

export function hasValidProcessorToken(request: Request) {
  const provided = request.headers.get("authorization");
  const expected = `Bearer ${env.PROCESS_VIDEO_ENDPOINT_AUTH}`;
  if (!provided) return false;

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}
