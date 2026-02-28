from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from .db import init_db, get_conn
from .analyze import analyze_track
from .djbrain import pick_next

AUDIO_DIR = Path("data/audio")

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
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)


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
    target = AUDIO_DIR / stored_name
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)

    with target.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    if target.stat().st_size == 0:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Wgrany plik jest pusty (0 bajtów).")

    with get_conn() as c:
        cur = c.execute(
            "INSERT INTO tracks(filename, original_name, mime, deleted) VALUES(?,?,?,0)",
            (stored_name, original_name, file.content_type),
        )
        track_id = cur.lastrowid

    return {"id": track_id, "stored_as": stored_name, "original_name": original_name}


@app.post("/tracks/analyze")
def analyze_all(include_deleted: bool = False):
    # domyślnie analizujemy tylko aktywne (nie w koszu)
    where = "" if include_deleted else "AND deleted=0"
    with get_conn() as c:
        rows = c.execute(f"SELECT * FROM tracks WHERE analyzed=0 {where}").fetchall()
        for r in rows:
            path = AUDIO_DIR / r["filename"]
            if not path.exists() or path.stat().st_size == 0:
                continue
            meta = analyze_track(path)
            c.execute(
                "UPDATE tracks SET duration=?, bpm=?, energy=?, analyzed=1 WHERE id=?",
                (meta["duration"], meta["bpm"], meta["energy"], r["id"]),
            )
    return {"status": "ok"}


@app.get("/tracks")
def list_tracks(include_deleted: bool = Query(False)):
    # include_deleted=True -> pokaż wszystko (aktywny + kosz)
    where = "" if include_deleted else "WHERE deleted=0"
    with get_conn() as c:
        rows = c.execute(f"SELECT * FROM tracks {where} ORDER BY id DESC").fetchall()
    return [dict(r) for r in rows]


@app.get("/set/next")
def next_track(current_id: int | None = None, target_energy: float = 0.6, history: str = ""):
    hist = [int(x) for x in history.split(",") if x.strip().isdigit()]
    with get_conn() as c:
        nxt = pick_next(c, current_id=current_id, target_energy=target_energy, history=hist)
    if not nxt:
        raise HTTPException(404, "Brak przeanalizowanych utworów (kliknij Analyze).")
    return nxt


@app.get("/tracks/{track_id}/stream")
def stream_track(track_id: int):
    with get_conn() as c:
        r = c.execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()
    if not r:
        raise HTTPException(404, "Nie ma takiego utworu")
    if int(r["deleted"] or 0) == 1:
        raise HTTPException(410, "Utwór jest w koszu (deleted).")

    path = AUDIO_DIR / r["filename"]
    if not path.exists():
        raise HTTPException(404, "Plik nie istnieje na dysku")
    return FileResponse(path)


# ---------- PRO: Kosz / usuwanie / przywracanie ----------

@app.delete("/tracks/{track_id}")
def soft_delete_track(track_id: int):
    # soft delete => tylko oznacz jako deleted=1, plik zostaje
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
    # hard delete => usuń z bazy i z dysku
    if not ids:
        return {"status": "ok", "purged": 0}

    with get_conn() as c:
        qmarks = ",".join("?" for _ in ids)
        rows = c.execute(f"SELECT id, filename FROM tracks WHERE id IN ({qmarks})", ids).fetchall()
        c.execute(f"DELETE FROM tracks WHERE id IN ({qmarks})", ids)

    for r in rows:
        p = AUDIO_DIR / r["filename"]
        if p.exists():
            p.unlink()

    return {"status": "ok", "purged": len(rows)}


@app.post("/tracks/purge-trash")
def purge_trash():
    # usuń trwale wszystko z kosza
    with get_conn() as c:
        rows = c.execute("SELECT id, filename FROM tracks WHERE deleted=1").fetchall()
        c.execute("DELETE FROM tracks WHERE deleted=1")

    for r in rows:
        p = AUDIO_DIR / r["filename"]
        if p.exists():
            p.unlink()

    return {"status": "ok", "purged": len(rows)}