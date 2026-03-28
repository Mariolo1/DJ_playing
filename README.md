# 🎧 DJ Playing — Light Auto-DJ (Docker)

![Backend Pulls](https://img.shields.io/docker/pulls/mariolo1/dj_playing-backend)
![Frontend Pulls](https://img.shields.io/docker/pulls/mariolo1/dj_playing-frontend)
![Backend Size](https://img.shields.io/docker/image-size/mariolo1/dj_playing-backend/latest)
![Frontend Size](https://img.shields.io/docker/image-size/mariolo1/dj_playing-frontend/latest)
![License](https://img.shields.io/badge/license-MIT-blue)

Lightweight Auto-DJ application for:

* uploading MP3/WAV files
* automatic playback
* simple mixing (mix interval + fade)
* S3-compatible storage (MinIO)

Optimized for Docker — **fast, small, and simple**.

---

## 🚀 Features

* 🎵 Upload MP3/WAV files
* ▶️ Automatic playback
* ⏱️ Mix interval (auto transition timing)
* 🔉 Fade-out before next track
* 📦 MinIO (S3) storage support
* 🧹 Trash / restore / permanent delete
* 🎛️ DJ-style UI

---

## ⚡ Lightweight Upgrade

### ❌ Removed (heavy stuff)

* BPM detection
* Energy analysis
* librosa / numpy / DSP
* ffmpeg dependencies
* complex AI DJ logic

### ✅ Result

* up to **80% smaller Docker images**
* faster build & deploy
* simpler architecture

---

## 🐳 Docker Images

* `mariolo1/dj_playing-backend`
* `mariolo1/dj_playing-frontend`

---

## ▶️ Quick Start

```bash
docker compose up -d
```

App will be available at:

* Frontend → http://localhost:3000
* Backend → http://localhost:8000

---

## ⚙️ Configuration

Backend supports S3-compatible storage (e.g. MinIO).

Set via environment variables:

* enable storage
* configure endpoint
* set credentials
* define bucket

---

## 📦 Architecture

* **Backend**: FastAPI
* **Frontend**: React + Nginx
* **Storage**: MinIO (S3)
* **Database**: SQLite

---

## 🎛️ How Auto-DJ Works

* tracks are played **sequentially (by ID)**
* after `mix interval` seconds:

  * fade-out starts
  * next track is loaded
* if track ends earlier → auto-next

---

## ⚠️ Limitations

* no BPM / beatmatching
* no tempo sync
* single audio player (no true crossfade)

👉 This is a **lightweight DJ player**, not a full DJ engine

---

## 🔥 Roadmap

* dual audio player (real crossfade)
* Web Audio API engine
* waveform visualization
* playlists & tagging

---

## 👤 Author

**Mariolo1**
