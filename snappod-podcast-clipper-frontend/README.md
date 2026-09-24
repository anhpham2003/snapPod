# SnapPod web application

SnapPod turns long-form podcasts and interviews into captioned, vertical short videos.

## Local development

1. Copy `.env.example` to `.env` and fill in the required values.
2. Run `npm ci`.
3. Create a PostgreSQL database and run `npm run db:migrate`.
4. Run `npm run dev`.

## Required environment variables

- `AUTH_SECRET`
- `DATABASE_URL`
- `AWS_REGION`
- `S3_BUCKET_NAME`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `PROCESS_VIDEO_ENDPOINT`
- `PROCESS_VIDEO_ENDPOINT_AUTH`
- `PROCESSING_PROGRESS_CALLBACK_URL`
- `PROCESSING_COMPLETION_CALLBACK_URL`

`PROCESS_VIDEO_ENDPOINT_AUTH` must match the Modal `AUTH_TOKEN`. The progress
callback uses the same shared secret. In production,
`PROCESSING_PROGRESS_CALLBACK_URL` is your Vercel application URL followed by
`/api/processing-progress`, and `PROCESSING_COMPLETION_CALLBACK_URL` ends with
`/api/processing-completion`.

## Deployment

1. Deploy the Modal worker and record the asynchronous enqueue endpoint.
2. Provision managed PostgreSQL and apply `npm run db:migrate`.
3. Add every variable from `.env.example` to the Vercel project.
4. Deploy this directory to Vercel.
5. Allow the deployed frontend origin in the S3 CORS policy.

## Validation

- `npm run check`
- `npm run build`
- `python3 -m unittest discover -s ../snapPod-podcast-clipper-backend/tests -v`

The GPU media-processing service is deployed separately from the Next.js application.
