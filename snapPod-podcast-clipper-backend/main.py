import modal
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
import os
import uuid
import hmac
import boto3
import pathlib
import whisperx
import subprocess
import sys
import time
import json
from google import genai
import shutil
import pickle
import glob
import numpy as np
from tqdm import tqdm
import cv2
import ffmpegcv
import pysubs2
from urllib import request as urllib_request
from pipeline_contracts import validate_moments

class ProcessVideoRequest(BaseModel):
    s3_key: str
    project_id: str
    job_id: str
    processing_version: int
    progress_callback_url: str
    completion_callback_url: str
    requested_clip_count: int = Field(default=3, ge=1, le=5)


def authorize_request(token: HTTPAuthorizationCredentials):
    expected = os.environ["AUTH_TOKEN"]
    if not hmac.compare_digest(token.credentials, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )

def report_progress(job: ProcessVideoRequest, stage: str, percent: int,
                    processed: int = 0, requested: int = 0):
    payload = json.dumps({
        "projectId": job.project_id,
        "jobId": job.job_id,
        "processingVersion": job.processing_version,
        "stage": stage,
        "progressPercent": min(percent, 99),
        "processedClipCount": processed,
        "requestedClipCount": requested,
    }).encode("utf-8")
    progress_request = urllib_request.Request(
        job.progress_callback_url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {os.environ['AUTH_TOKEN']}",
        },
        method="POST",
    )
    try:
        with urllib_request.urlopen(progress_request, timeout=10) as response:
            if response.status >= 300:
                print(f"Progress callback returned status {response.status}")
    except Exception as callback_error:
        # Progress reporting should never discard otherwise usable video output.
        print(f"Progress callback failed: {callback_error}")


def report_completion(job: ProcessVideoRequest, result: dict):
    payload = json.dumps({
        "projectId": job.project_id,
        "jobId": job.job_id,
        "processingVersion": job.processing_version,
        **result,
    }).encode("utf-8")
    last_error = None
    for attempt in range(3):
        completion_request = urllib_request.Request(
            job.completion_callback_url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {os.environ['AUTH_TOKEN']}",
            },
            method="POST",
        )
        try:
            with urllib_request.urlopen(completion_request, timeout=30) as response:
                if response.status >= 300:
                    raise RuntimeError(
                        f"Completion callback returned status {response.status}"
                    )
                return
        except Exception as callback_error:
            last_error = callback_error
            if attempt < 2:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"Completion callback failed: {last_error}")

def s3_bucket_name():
    value = os.environ.get("S3_BUCKET_NAME")
    if not value:
        raise RuntimeError("S3_BUCKET_NAME is not configured")
    return value

# don't change these layers unless have to
image = (modal.Image.from_registry(
    "nvidia/cuda:12.4.0-devel-ubuntu22.04", add_python="3.12")
    .apt_install(["ffmpeg", "libgl1-mesa-glx", "wget", "libcudnn8", "libcudnn8-dev"])
    .pip_install_from_requirements('requirements.txt')
    .run_commands(["mkdir -p /usr/share/fonts/truetype/custom",
                   "wget -O /usr/share/fonts/truetype/custom/Anton-Regular.ttf https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf",
                   "fc-cache -f -v"])
    .add_local_dir("asd", "/asd", copy=True)
    .add_local_python_source("pipeline_contracts"))

app = modal.App('ai-podcast-clipper', image=image)

volume = modal.Volume.from_name(
    "ai-podcast-clipper-model-cache", create_if_missing=True
)
mount_path = "/root/.cache/torch"

auth_scheme = HTTPBearer()

def create_vertical_video(tracks, scores, pyframes_path, pyavi_path, audio_path, output_path, framerate=25):
    target_width = 1080
    target_height = 1920

    flist = glob.glob(os.path.join(pyframes_path, "*.jpg"))
    flist.sort()

    faces = [[] for _ in range(len(flist))]

    for tidx, track in enumerate(tracks):
        score_array = scores[tidx]
        for fidx, frame in enumerate(track['track']['frame'].tolist()):
            slice_start = max(fidx - 30, 0)
            slice_end = min(fidx + 30, len(score_array))
            score_slice = score_array[slice_start:slice_end]
            avg_score = float(np.mean(score_slice) if len(score_slice) > 0 else 0)

            faces[frame].append({'track': tidx, 'score': avg_score, 's': track['proc_track']['s'][fidx], 
                                 'x': track['proc_track']['x'][fidx], 'y': track['proc_track']['y'][fidx]})
            
    tempt_video_path = os.path.join(pyavi_path, "video_only.mp4")

    vout = None
    for fidx, fname in tqdm(enumerate(flist), total=len(flist), desc="Creating vertical video"):
        img = cv2.imread(fname)
        if img is None:
            continue

        current_faces = faces[fidx]

        max_score_face = max(current_faces, key=lambda face: face['score']) if current_faces else None

        if max_score_face and max_score_face['score'] < 0:
            max_score_face = None
        
        if vout is None:
            vout = ffmpegcv.VideoWriterNV(
                file=tempt_video_path,
                codec=None,
                fps=framerate,
                resize=(target_width, target_height)
            )
        if max_score_face:
            mode = 'crop'
        else:
            mode = 'resize'
        
        if mode == 'resize':
            scale = target_width / img.shape[1]
            resized_height = int(img.shape[0] * scale)
            resize_image = cv2.resize(img, (target_width, resized_height), interpolation=cv2.INTER_AREA)
            scale_for_bg = max(target_width / img.shape[1], target_height / img.shape[0])
            bg_width = int(img.shape[1] * scale_for_bg)
            bg_height = int(img.shape[0] * scale_for_bg)
            blurred_bg = cv2.resize(img,(bg_width, bg_height))
            blurred_bg = cv2.GaussianBlur(blurred_bg, (121, 121), 0)

            crop_x = (bg_width - target_width) // 2
            crop_y = (bg_height - target_height) // 2

            blurred_background = blurred_bg[crop_y:crop_y + target_height, crop_x:crop_x + target_width]

            center_y = (target_height - resized_height) // 2
            blurred_background[center_y:center_y + resized_height, :] = resize_image

            vout.write(blurred_background)

        elif mode == 'crop':
            scale = target_height / img.shape[0]
            resize_img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            frame_width = resize_img.shape[1]

            center_x = int(max_score_face['x'] * scale if max_score_face else frame_width // 2)
            top_x = max(min(center_x - target_width // 2, frame_width - target_width), 0)

            image_cropped = resize_img[0:target_height, top_x:top_x + target_width]

            vout.write(image_cropped)
    if vout:
        vout.release()
    
    subprocess.run([
        "ffmpeg", "-y", "-i", str(tempt_video_path), "-i", str(audio_path),
        "-c:v", "h264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k", str(output_path),
    ], check=True, capture_output=True, text=True, timeout=600)

def create_subtitles_with_ffmpeg(transcript_segments: list, clip_start: float, clip_end: float, clip_video_path: str, output_path: str, max_words: int = 5):
    temp_dir = os.path.dirname(output_path)
    subtitle_path = os.path.join(temp_dir, "temp_subtitles.ass")

    clip_segments = [segment for segment in transcript_segments
                     if segment.get('start') is not None and segment.get('end') is not None
                     and segment.get('end') > clip_start and segment.get('start') < clip_end]
    
    subtitles = []
    current_words = []
    current_start = None
    current_end = None
    
    for segment in clip_segments:
        word = segment.get('word', '').strip()
        seg_start = segment.get('start')
        seg_end = segment.get('end')

        if not word or seg_start is None or seg_end is None:
            continue

        start_rel = max(0.0, seg_start - clip_start)
        end_rel = max(0.0, seg_end - clip_start)

        if end_rel <= 0:
            continue
        
        if not current_words:
            current_start = start_rel
            current_end = end_rel
            current_words = [word]
        elif len(current_words) >= max_words:
            subtitles.append((current_start, current_end, ' '.join(current_words)))
            current_words = [word]
            current_start = start_rel
            current_end = end_rel
        else:
            current_words.append(word)
            current_end = end_rel
        
    if current_words:
        subtitles.append((current_start, current_end, ' '.join(current_words)))
    subs = pysubs2.SSAFile()

    subs.info['WrapStyle'] = 0
    subs.info['ScaledBorderAndShadow'] = 'yes'
    subs.info['PlayResX'] = 1080
    subs.info['PlayResY'] = 1920
    subs.info['ScriptType'] = 'v4.00+'

    style_name = 'Default'
    new_style = pysubs2.SSAStyle()
    new_style.fontname = 'Anton'
    new_style.fontsize = 140
    new_style.primary_color = pysubs2.Color(255, 255, 255)
    new_style.outline = 2.0
    new_style.shadow = 2.0
    new_style.shadowcolor = pysubs2.Color(0, 0, 0, 128)
    new_style.alignment = 2
    new_style.marginl = 50 
    new_style.marginr = 50
    new_style.marginv = 50
    new_style.spacing = 0.0

    subs.styles[style_name] = new_style

    for i, (start, end, text) in enumerate(subtitles):
        start_time = pysubs2.make_time(s=start)
        end_time = pysubs2.make_time(s=end)
        line = pysubs2.SSAEvent(start=start_time, end=end_time, text=text, style=style_name)
        subs.events.append(line)

    subs.save(subtitle_path)

    subprocess.run([
        "ffmpeg", "-y", "-i", str(clip_video_path),
        "-vf", f"ass={subtitle_path}", "-c:v", "h264",
        "-preset", "fast", "-crf", "23", str(output_path),
    ], check=True, capture_output=True, text=True, timeout=600)

def render_clip(base_dir: str, original_vid_path: str, s3_key: str, start_time: float, end_time: float, clip_index: int):
    clip_name = f"clip_{clip_index}"
    if "/source/" not in s3_key:
        raise ValueError("Source key is not scoped to a project")
    project_prefix = s3_key.split("/source/", 1)[0]
    output_s3_key = f"{project_prefix}/renders/{clip_name}.mp4"
    print(f"Output S3 key: {output_s3_key}")

    clip_dir = base_dir / clip_name
    clip_dir.mkdir(parents=True, exist_ok=True)

    clip_segment_path = clip_dir / f"{clip_name}_segment.mp4"
    vertical_mp4_path = clip_dir / "pyavi" / "video_out_vertical.mp4"
    subtitle_output_path = clip_dir / "pyavi" / "video_with_subtitles.mp4"

    (clip_dir / "pywork").mkdir(exist_ok=True)
    pyframes_path = clip_dir / "pyframes"
    pyavi_path = clip_dir / "pyavi"
    audio_path = clip_dir / "pyavi" / "audio.wav"

    pyframes_path.mkdir(exist_ok=True)
    pyavi_path.mkdir(exist_ok=True)

    duration = end_time - start_time
    subprocess.run([
        "ffmpeg", "-y", "-i", str(original_vid_path), "-ss", str(start_time),
        "-t", str(duration), str(clip_segment_path),
    ], check=True, capture_output=True, text=True, timeout=300)

    subprocess.run([
        "ffmpeg", "-y", "-i", str(clip_segment_path), "-vn",
        "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", str(audio_path),
    ], check=True, capture_output=True, text=True, timeout=300)

    shutil.copy(clip_segment_path, base_dir / f"{clip_name}.mp4")

    columbia_start_time = time.time()
    subprocess.run([
        sys.executable, "Columbia_test.py", "--videoName", clip_name,
        "--videoFolder", str(base_dir),
        "--pretrainModel", "weight/finetuning_TalkSet.model",
    ], cwd="/asd", check=True, capture_output=True, text=True, timeout=600)
    columbia_end_time = time.time()
    print(f"Columbia script completed in {columbia_end_time - columbia_start_time:.2f} seconds")


    track_path = clip_dir / "pywork" / "tracks.pckl"
    scores_path = clip_dir / "pywork" / "scores.pckl"
    if not track_path.exists() or not scores_path.exists():
        raise FileNotFoundError("Tracks or scores not found for clip")
    
    with open(track_path, "rb") as f:
        tracks = pickle.load(f)

    with open(scores_path, "rb") as f:
        scores = pickle.load(f)

    cvv_start_time = time.time()
    create_vertical_video(
        tracks, scores, pyframes_path, pyavi_path, audio_path, vertical_mp4_path
    )
    cvv_end_time = time.time()
    print(f"Clip {clip_index} vertical video creation time: {cvv_end_time - cvv_start_time:.2f} seconds")

    return {
        "start_time": start_time,
        "end_time": end_time,
        "vertical_path": vertical_mp4_path,
        "subtitle_path": subtitle_output_path,
        "output_s3_key": output_s3_key,
    }

def caption_and_upload(rendered_clip: dict, transcript_segments: list):
    create_subtitles_with_ffmpeg(
        transcript_segments,
        rendered_clip["start_time"],
        rendered_clip["end_time"],
        rendered_clip["vertical_path"],
        rendered_clip["subtitle_path"],
        max_words=5,
    )
    s3_client = boto3.client("s3")
    s3_client.upload_file(
        rendered_clip["subtitle_path"],
        s3_bucket_name(),
        rendered_clip["output_s3_key"],
    )
    return rendered_clip["output_s3_key"]

@app.cls(gpu="T4", timeout=3600, retries=0, scaledown_window=20, secrets=[modal.Secret.from_name('ai-podcast-clipper-secret')], volumes={mount_path: volume})
class AIPodcastClipper:
    @modal.enter()
    def load_model(self):
        print("Loading models")
        self.whisperx_model = whisperx.load_model("large-v2", device="cuda", compute_type="float16")
        self.alignment_model, self.metadata = whisperx.load_align_model(
            language_code="en", device="cuda"
        )
        print("Transcription models loaded...")

        print("Creating gemini client..")
        self.gemini_client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        print("Created gemini client")
    def transcribe_video(self, base_dir: str, video_path: str) -> str:
        audio_path = base_dir / "audio.wav"
        subprocess.run([
            "ffmpeg", "-y", "-i", str(video_path), "-vn",
            "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", str(audio_path),
        ], check=True, capture_output=True, timeout=600)

        print('Starting transcription with WhisperX..')
        start_time = time.time()
        audio = whisperx.load_audio(str(audio_path))
        # Keep the Phase 1 test deployment within the T4's smaller VRAM budget.
        result = self.whisperx_model.transcribe(audio, batch_size=8)

        result = whisperx.align(
            result['segments'],
            self.alignment_model,
            self.metadata,
            audio,
            device="cuda",
            return_char_alignments=False
        )
        duration = time.time() - start_time
        print("Transcription and alignment took" + str(duration) + " seconds")

        segments = []

        if "word_segments" in result:
            for word_segment in result["word_segments"]:
                segments.append({
                    "start": word_segment["start"],
                    "end": word_segment["end"],
                    "word": word_segment["word"]
                })
        return json.dumps(segments)


    def identify_moments(self, transcript: list, candidate_count: int):
        response = self.gemini_client.models.generate_content(model='gemini-2.5-flash', contents = f"""
    This is a podcast video transcript consisting of word, along with each word's start and end time. I am looking to create clips between a minimum of 30 and maximum of 60 seconds long. The clip should never exceed 60 seconds.

    Your task is to find and extract stories, or question and their corresponding answers from the transcript.
    Each clip should begin with the question and conclude with the answer.
    It is acceptable for the clip to include a few additional sentences before a question if it aids in contextualizing the question.

    Please adhere to the following rules:
    - Ensure that clips do not overlap with one another.
    - Start and end timestamps of the clips should align perfectly with the sentence boundaries in the transcript.
    - Only use the start and end timestamps provided in the input. modifying timestamps is not allowed.
    - Format the output as a list of JSON objects, each representing a clip with 'start' and 'end' timestamps: [{"start": seconds, "end": seconds}, ...clip2, clip3]. The output should always be readable by the python json.loads function.
    - Aim to generate longer clips between 40-60 seconds, and ensure to include as much content from the context as viable.
    - Return at most {candidate_count} candidates, ordered from strongest to weakest.

    Avoid including:
    - Moments of greeting, thanking, or saying goodbye.
    - Non-question and answer interactions.

    If there are no valid clips to extract, the output should be an empty list [], in JSON format. Also readable by json.loads() in Python.

    The transcript is as follows:\n\n""" + str(transcript))
        print(f"Identified moments response: ${response.text}")
        return response.text

    @modal.method()
    def process_video(self, request_data: dict):
        request = ProcessVideoRequest.model_validate(request_data)
        s3_key = request.s3_key
        run_id = str(uuid.uuid4())
        base_dir = pathlib.Path("/tmp") / run_id
        base_dir.mkdir(parents=True, exist_ok=True)
        try:
            report_progress(request, "PREPARING_VIDEO", 7)
            video_path = base_dir / "input.mp4"
            boto3.client("s3").download_file(s3_bucket_name(), s3_key, str(video_path))

            report_progress(request, "TRANSCRIBING", 15)
            transcript_segments = json.loads(self.transcribe_video(base_dir, video_path))

            report_progress(request, "IDENTIFYING_MOMENTS", 45)
            candidate_count = min(request.requested_clip_count * 2, 10)
            identified_raw = self.identify_moments(transcript_segments, candidate_count)
            cleaned = identified_raw.strip()
            if cleaned.startswith("```json"):
                cleaned = cleaned[len("```json"):].strip()
            if cleaned.endswith("```"):
                cleaned = cleaned[:-len("```")].strip()
            try:
                moments = json.loads(cleaned)
            except json.JSONDecodeError as model_error:
                raise RuntimeError("Gemini returned invalid moment data") from model_error
            selected_moments = validate_moments(
                moments, transcript_segments, request.requested_clip_count
            )

            rendered_clips = []
            successful_keys = []
            failed_clip_count = 0
            selected_count = len(selected_moments)
            report_progress(request, "CREATING_CLIPS", 60, 0, selected_count)
            for index, moment in enumerate(selected_moments):
                try:
                    rendered_clips.append(render_clip(
                        base_dir, video_path, s3_key, moment["start"], moment["end"], index
                    ))
                except Exception as clip_error:
                    failed_clip_count += 1
                    print(f"Clip {index} render failed: {clip_error}")
                completed = len(rendered_clips) + failed_clip_count
                report_progress(
                    request, "CREATING_CLIPS",
                    60 + int((completed / max(selected_count, 1)) * 25),
                    len(rendered_clips), selected_count
                )

            report_progress(request, "ADDING_CAPTIONS", 85, 0, selected_count)
            for rendered_clip in rendered_clips:
                try:
                    successful_keys.append(caption_and_upload(rendered_clip, transcript_segments))
                except Exception as clip_error:
                    failed_clip_count += 1
                    print(f"Clip caption/upload failed: {clip_error}")
                completed = len(successful_keys) + failed_clip_count
                report_progress(
                    request, "ADDING_CAPTIONS",
                    85 + int((completed / max(selected_count, 1)) * 10),
                    len(successful_keys), selected_count
                )

            report_progress(request, "FINALIZING", 95, len(successful_keys), selected_count)
            result = {
                "requested_clip_count": request.requested_clip_count,
                "candidates_found": len(moments) if isinstance(moments, list) else 0,
                "valid_candidate_count": selected_count,
                "successful_keys": successful_keys,
                "failed_clip_count": failed_clip_count,
                "error_code": None,
                "error_message": None,
            }
            report_completion(request, result)
            return result
        except Exception as processing_error:
            print(f"Processing job {request.job_id} failed: {processing_error}")
            report_completion(request, {
                "requested_clip_count": request.requested_clip_count,
                "candidates_found": 0,
                "valid_candidate_count": 0,
                "successful_keys": [],
                "failed_clip_count": request.requested_clip_count,
                "error_code": "PROCESSING_FAILED",
                "error_message": "SnapPod could not finish this video.",
            })
            raise
        finally:
            if base_dir.exists():
                print(f"Cleaning up temp dir after {base_dir}")
                shutil.rmtree(base_dir, ignore_errors=True)


@app.function(
    timeout=60,
    secrets=[modal.Secret.from_name('ai-podcast-clipper-secret')],
)
@modal.fastapi_endpoint(method="POST")
def enqueue_video(
    request: ProcessVideoRequest,
    token: HTTPAuthorizationCredentials = Depends(auth_scheme),
):
    authorize_request(token)
    if f"/projects/{request.project_id}/source/" not in request.s3_key:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Source key does not match the project",
        )

    function_call = AIPodcastClipper().process_video.spawn(request.model_dump())
    return {
        "accepted": True,
        "external_job_id": function_call.object_id,
    }


@app.local_entrypoint()
def main():
    import requests

    url = enqueue_video.web_url

    payload = {
        "s3_key": "users/test/projects/test/source/original.mp4",
        "project_id": "test",
        "job_id": "test-job",
        "processing_version": 1,
        "progress_callback_url": "http://localhost:3000/api/processing-progress",
        "completion_callback_url": "http://localhost:3000/api/processing-completion",
        "requested_clip_count": 3,
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {os.environ['AUTH_TOKEN']}"
    }

    response = requests.post(url, json=payload, headers=headers)

    response.raise_for_status()
    result = response.json()
    print(result)
