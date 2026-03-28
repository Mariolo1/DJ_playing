from __future__ import annotations

import uuid

from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .db import init_db, get_conn
from .storage import (
    ensure_storage_ready,
    save_upload,
    object_exists,
    open_stream,
    delete_object,
)

app = FastAPI(title="Auto-DJ Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup():
    init_db()
    ensure_storage_ready()


@app.get("/")
def root():
    return {"ok": True, "service": "auto-dj-backend"}


@app.post("/tracks/upload")
async def upload_track(file: UploadFile = File(...)):
    ct = (file.content_type or "").lower()
    if ct not in {"audio/mpeg", "audio/wav", "audio/x-wav", "audio/wave"}:
        raise HTTPException(status_code=400, detail="Wspierane tylko MP3/WAV")

    original_name = file.filename or "track"
    suffix = ".mp3" if "mpeg" in ct else ".wav"
    stored_name = f"{uuid.uuid4().hex}{suffix}"

    try:
        save_upload(file.file, stored_name, file.content_type)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")

    with get_conn() as c:
        cur = c.execute(
            "INSERT INTO tracks(filename, original_name, mime, deleted) VALUES(?,?,?,0)",
            (stored_name, original_name, file.content_type),
        )
        track_id = cur.lastrowid

    return {"id": track_id, "stored_as": stored_name, "original_name": original_name}


@app.get("/tracks")
def list_tracks(include_deleted: bool = Query(False)):
    where = "" if include_deleted else "WHERE deleted=0"
    with get_conn() as c:
        rows = c.execute(f"SELECT * FROM tracks {where} ORDER BY id DESC").fetchall()
    return [dict(r) for r in rows]


@app.get("/set/next")
def next_track(current_id: int | None = None):
    with get_conn() as c:
        row = None

        if current_id is not None:
            row = c.execute(
                "SELECT * FROM tracks WHERE deleted=0 AND id > ? ORDER BY id ASC LIMIT 1",
                (current_id,),
            ).fetchone()

        if not row:
            row = c.execute(
                "SELECT * FROM tracks WHERE deleted=0 ORDER BY id ASC LIMIT 1"
            ).fetchone()

    if not row:
        raise HTTPException(404, "Brak utworów.")

    return dict(row)


@app.get("/tracks/{track_id}/stream")
def stream_track(track_id: int):
    with get_conn() as c:
        r = c.execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()

    if not r:
        raise HTTPException(404, "Nie ma takiego utworu")
    if int(r["deleted"] or 0) == 1:
        raise HTTPException(410, "Utwór jest w koszu (deleted).")

    filename = r["filename"]
    mime = r["mime"] or "application/octet-stream"

    if not object_exists(filename):
        raise HTTPException(404, "Plik nie istnieje w storage")

    stream = open_stream(filename)

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": f'inline; filename="{filename}"',
    }

    return StreamingResponse(stream, media_type=mime, headers=headers)


@app.delete("/tracks/{track_id}")
def soft_delete_track(track_id: int):
    with get_conn() as c:
        row = c.execute("SELECT id FROM tracks WHERE id=?", (track_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Track not found")
        c.execute("UPDATE tracks SET deleted=1 WHERE id=?", (track_id,))
    return {"status": "deleted", "mode": "soft"}


@app.post("/tracks/restore")
def restore_tracks(ids: list[int]):
    if not ids:
        return {"status": "ok", "restored": 0}
    with get_conn() as c:
        qmarks = ",".join("?" for _ in ids)
        cur = c.execute(f"UPDATE tracks SET deleted=0 WHERE id IN ({qmarks})", ids)
    return {"status": "ok", "restored": cur.rowcount}


@app.post("/tracks/purge")
def purge_tracks(ids: list[int]):
    if not ids:
        return {"status": "ok", "purged": 0}

    with get_conn() as c:
        qmarks = ",".join("?" for _ in ids)
        rows = c.execute(f"SELECT id, filename FROM tracks WHERE id IN ({qmarks})", ids).fetchall()
        c.execute(f"DELETE FROM tracks WHERE id IN ({qmarks})", ids)

    for r in rows:
        delete_object(r["filename"])

    return {"status": "ok", "purged": len(rows)}


@app.post("/tracks/purge-trash")
def purge_trash():
    with get_conn() as c:
        rows = c.execute("SELECT id, filename FROM tracks WHERE deleted=1").fetchall()
        c.execute("DELETE FROM tracks WHERE deleted=1")

    for r in rows:
        delete_object(r["filename"])

    return {"status": "ok", "purged": len(rows)}