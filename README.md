# 🎙️ SnapPodAI Podcast Clipper

Turn full-length podcasts into viral short-form content in minutes.  
No editing skills needed — just upload and go.

## 🚀 Overview 

##### This is a full-stack AI-powered SaaS app that transforms podcasts into shareable short-form videos perfect for TikTok, YouTube Shorts, and Reels. It auto-identifies viral moments, crops to the active speaker’s face, and overlays subtitles — all with minimal user input.
---
##✨ Features

- 🎬 **Auto-detects viral moments** (stories, Q&A, etc.)
- 🧠 **LLM-powered moment detection** using Gemini 2.5 Pro
- 🔊 **Subtitles added automatically** via `m-bain/whisperX`
- 🎯 **Active speaker cropping** with `Junhua-Liao/LR-ASD`
- 📱 **Optimized for vertical formats** (TikTok, Shorts, Reels)
- 🎞️ **GPU-accelerated video rendering** with FFMPEGCV on Modal
- 💳 **Credit system** with Stripe for purchasing clip credits
- 👤 **User authentication** via Auth.js
- 📊 **Dashboard** for uploads, previews, and clip management
- ⚙️ **Durable asynchronous jobs** with PostgreSQL and Modal
- 🌐 **FastAPI** endpoint for podcast processing
- 🖼️ **Modern UI** using Tailwind CSS + Shadcn
---
## 🧠 Tech Stack

| Layer        | Tools / Frameworks                                 |
|-------------|-----------------------------------------------------|
| Frontend     | Next.js 16, React, TypeScript, Tailwind CSS, ShadCN |
| Backend      | FastAPI, Python, WhisperX, LR-ASD, Gemini 2.5 Pro  |
| Infrastructure | Modal, PostgreSQL, AWS S3, Vercel, Auth.js          |
| Media/Rendering | FFMPEGCV (GPU), Gemini 2.5 Pro                    |
---
## 🛠 Setup
### 1. Clone the Repository

```bash
git clone --recurse-submodules https://github.com/anhpham2003/snapPod.git
```

### Install Python
Download and install Python if not already installed. Use the link below for guidance on installation: Python Download

Create a virtual environment with Python 3.12.

### Install Dependencies
```bash
pip install -r requirements.txt
```

### Clone LR-ASD and rename
```bash
git clone https://github.com/Junhua-Liao/LR-ASD.git
mv LR-ASD asd
```

### Set up Modal
```bash
modal set up
```

To test locally:
```bash
modal run main.py
```

## Key Pipelines
| Stage               | Tool / Model            |
| ------------------- | ----------------------- |
| Transcription       | `m-bain/whisperX`       |
| Viral Moment Mining | Gemini 2.5 Pro (LLM)    |
| Active Speaker Crop | `LR-ASD`                |
| Clip Rendering      | `FFMPEGCV` on Modal GPU |
| Storage             | AWS S3                  |


## Test Cases
- [MI6 Secret Agent Talks About the World's Darkest Secrets ](https://www.youtube.com/watch?v=-vMgbJ6WqN4)
- [Janney Sanchez | Therapy saved my life – Ep.198](https://www.youtube.com/watch?v=SOG0GmKts_I)

## Next Steps:
Once backend pipelines are stable:
- Hook into the frontend dashboard
- Expose FastAPI endpoints to manage clip status & trigger jobs
- Wire up credit-based usage limits via Stripe + user auth
- Add unit tests for processing components
