from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile

import numpy as np
import librosa


def _decode_to_wav_with_ffmpeg(src: Path) -> Path:
    # Stabilne dekodowanie MP3 (i innych) na Linux/Windows:
    # ffmpeg do WAV PCM mono 22050Hz w katalogu tymczasowym.
    # Wymaga ffmpeg w PATH (w Dockerfile instalujemy).
    tmp_dir = Path(tempfile.mkdtemp(prefix="auto_dj_"))
    out_wav = tmp_dir / (src.stem + ".wav")

    src_abs = src.resolve()
    out_abs = out_wav.resolve()

    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", str(src_abs),
        "-ac", "1",
        "-ar", "22050",
        "-vn",
        str(out_abs),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)

    if proc.returncode != 0 or not out_abs.exists() or out_abs.stat().st_size == 0:
        raise RuntimeError(
            "FFmpeg decode failed.\n"
            f"CMD: {' '.join(cmd)}\n"
            f"STDERR:\n{proc.stderr}\n"
            f"STDOUT:\n{proc.stdout}\n"
        )

    return out_abs


def analyze_track(path: Path) -> dict:
    wav_path: Path | None = None
    try:
        if path.suffix.lower() in {".mp3", ".m4a", ".aac", ".ogg"}:
            wav_path = _decode_to_wav_with_ffmpeg(path)
            load_path = wav_path
        else:
            load_path = path

        y, sr = librosa.load(load_path.as_posix(), mono=True)
        duration = float(librosa.get_duration(y=y, sr=sr))

        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(tempo)

        rms = librosa.feature.rms(y=y)[0]
        energy = float(np.clip(np.mean(rms) / (np.max(rms) + 1e-9), 0.0, 1.0))

        return {"duration": duration, "bpm": bpm, "energy": energy}

    finally:
        if wav_path and wav_path.exists():
            try:
                wav_path.unlink()
                wav_path.parent.rmdir()
            except Exception:
                pass
