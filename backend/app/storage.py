from __future__ import annotations

import io
import os
from pathlib import Path
from typing import BinaryIO

from minio import Minio
from minio.error import S3Error

MINIO_ENABLED = os.getenv("MINIO_ENABLED", "false").lower() == "true"
MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "minio:9000")
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY", "minioadmin123")
MINIO_BUCKET = os.getenv("MINIO_BUCKET", "dj-audio")
MINIO_SECURE = os.getenv("MINIO_SECURE", "false").lower() == "true"

LOCAL_AUDIO_DIR = Path(os.getenv("AUDIO_DIR", "data/audio"))


def get_minio_client() -> Minio:
    return Minio(
        MINIO_ENDPOINT,
        access_key=MINIO_ACCESS_KEY,
        secret_key=MINIO_SECRET_KEY,
        secure=MINIO_SECURE,
    )


def ensure_storage_ready() -> None:
    if MINIO_ENABLED:
        client = get_minio_client()
        found = client.bucket_exists(MINIO_BUCKET)
        if not found:
            client.make_bucket(MINIO_BUCKET)
    else:
        LOCAL_AUDIO_DIR.mkdir(parents=True, exist_ok=True)


def save_upload(fileobj: BinaryIO, object_name: str, content_type: str | None = None) -> None:
    if MINIO_ENABLED:
        data = fileobj.read()
        length = len(data)
        if length == 0:
            raise ValueError("Wgrany plik jest pusty (0 bajtów).")

        client = get_minio_client()
        client.put_object(
            MINIO_BUCKET,
            object_name,
            io.BytesIO(data),
            length=length,
            content_type=content_type or "application/octet-stream",
        )
    else:
        LOCAL_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
        target = LOCAL_AUDIO_DIR / object_name
        with target.open("wb") as f:
            f.write(fileobj.read())

        if target.stat().st_size == 0:
            target.unlink(missing_ok=True)
            raise ValueError("Wgrany plik jest pusty (0 bajtów).")


def object_exists(object_name: str) -> bool:
    if MINIO_ENABLED:
        client = get_minio_client()
        try:
            client.stat_object(MINIO_BUCKET, object_name)
            return True
        except S3Error:
            return False
    return (LOCAL_AUDIO_DIR / object_name).exists()


def open_stream(object_name: str):
    if MINIO_ENABLED:
        client = get_minio_client()
        return client.get_object(MINIO_BUCKET, object_name)
    return (LOCAL_AUDIO_DIR / object_name).open("rb")


def delete_object(object_name: str) -> None:
    if MINIO_ENABLED:
        client = get_minio_client()
        try:
            client.remove_object(MINIO_BUCKET, object_name)
        except S3Error:
            pass
    else:
        p = LOCAL_AUDIO_DIR / object_name
        if p.exists():
            p.unlink()