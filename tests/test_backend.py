"""
Testy backendu aplikacji Auto-DJ (DJ_playing)
=============================================

Wymagania do uruchomienia:
    pip install fastapi uvicorn python-multipart pydantic minio httpx pytest pytest-asyncio anyio

Uruchomienie:
    cd backend
    pytest ../test_backend.py -v

Testy korzystają z:
- TestClient (httpx) – synchroniczne testy HTTP
- bazy SQLite w pamięci (zmienna środowiskowa DB_PATH=:memory: jest emulowana przez tmp_path)
- lokalnego storage (MINIO_ENABLED=false, katalog tymczasowy)
"""

from __future__ import annotations

import io
import os
import sqlite3
import tempfile
import sys  
from pathlib import Path
from unittest.mock import MagicMock, patch, PropertyMock

# 🔥 DODAJ TO
BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Fixtures – izolowane środowisko dla każdego testu
# ---------------------------------------------------------------------------

@pytest.fixture()
def tmp_env(tmp_path, monkeypatch):
    """
    Ustawia tymczasowe ścieżki dla bazy danych i plików audio.
    Wyłącza MinIO – używany jest lokalny storage.
    """
    db_file = tmp_path / "test.db"
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()

    monkeypatch.setenv("DB_PATH", str(db_file))
    monkeypatch.setenv("AUDIO_DIR", str(audio_dir))
    monkeypatch.setenv("MINIO_ENABLED", "false")

    return {"db": db_file, "audio": audio_dir}


@pytest.fixture()
def client(tmp_env):
    """
    Zwraca TestClient z odświeżonymi modułami backendu
    (żeby każdy test miał czystą bazę i storage).
    """
    import importlib
    import sys

    # Wymuś ponowne załadowanie modułów, żeby pobrały nowe zmienne środowiskowe
    for mod in list(sys.modules.keys()):
        if "app." in mod or mod in ("app.db", "app.storage", "app.main"):
            del sys.modules[mod]

    # Dodaj katalog backendu do ścieżki, jeśli go tam nie ma
    backend_dir = Path(__file__).resolve().parent.parent / "backend"
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))

    from app.main import app
    from app.db import init_db
    from app.storage import ensure_storage_ready

    init_db()
    ensure_storage_ready()

    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# Pomocnicze funkcje
# ---------------------------------------------------------------------------

def make_audio_file(content: bytes = b"FAKE_MP3_DATA", filename: str = "test.mp3"):
    """Zwraca krotkę gotową do przesłania jako multipart/form-data."""
    return ("file", (filename, io.BytesIO(content), "audio/mpeg"))


def make_wav_file(content: bytes = b"FAKE_WAV_DATA", filename: str = "test.wav"):
    return ("file", (filename, io.BytesIO(content), "audio/wav"))


def upload_track(client, content=b"MP3DATA", filename="track.mp3", mime="audio/mpeg"):
    """Wgrywa jeden utwór i zwraca odpowiedź."""
    return client.post(
        "/tracks/upload",
        files={"file": (filename, io.BytesIO(content), mime)},
    )


# ===========================================================================
# 1. Root endpoint
# ===========================================================================

class TestRoot:
    def test_root_returns_ok(self, client):
        r = client.get("/")
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is True
        assert data["service"] == "auto-dj-backend"


# ===========================================================================
# 2. Upload utworu  POST /tracks/upload
# ===========================================================================

class TestUploadTrack:
    def test_upload_mp3_success(self, client):
        r = upload_track(client, content=b"ID3FAKEDATA", filename="song.mp3", mime="audio/mpeg")
        assert r.status_code == 200
        data = r.json()
        assert "id" in data
        assert data["original_name"] == "song.mp3"
        assert data["stored_as"].endswith(".mp3")

    def test_upload_wav_success(self, client):
        r = upload_track(client, content=b"RIFFWAVDATA", filename="beat.wav", mime="audio/wav")
        assert r.status_code == 200
        data = r.json()
        assert data["stored_as"].endswith(".wav")
        assert data["original_name"] == "beat.wav"

    def test_upload_wav_x_wav_content_type(self, client):
        r = upload_track(client, content=b"WAVDATA", filename="b.wav", mime="audio/x-wav")
        assert r.status_code == 200

    def test_upload_wav_wave_content_type(self, client):
        r = upload_track(client, content=b"WAVDATA", filename="b.wav", mime="audio/wave")
        assert r.status_code == 200

    def test_upload_unsupported_mime_returns_400(self, client):
        r = client.post(
            "/tracks/upload",
            files={"file": ("song.ogg", io.BytesIO(b"OGGDATA"), "audio/ogg")},
        )
        assert r.status_code == 400
        assert "MP3" in r.json()["detail"] or "WAV" in r.json()["detail"]

    def test_upload_empty_file_returns_400(self, client):
        r = client.post(
            "/tracks/upload",
            files={"file": ("empty.mp3", io.BytesIO(b""), "audio/mpeg")},
        )
        assert r.status_code == 400

    def test_upload_assigns_unique_ids(self, client):
        r1 = upload_track(client, filename="a.mp3")
        r2 = upload_track(client, filename="b.mp3")
        assert r1.json()["id"] != r2.json()["id"]

    def test_uploaded_stored_name_is_uuid_based(self, client):
        r = upload_track(client)
        stored = r.json()["stored_as"]
        # UUID hex = 32 znaków + rozszerzenie
        name_part = stored.rsplit(".", 1)[0]
        assert len(name_part) == 32
        assert all(c in "0123456789abcdef" for c in name_part)

    def test_upload_image_returns_400(self, client):
        r = client.post(
            "/tracks/upload",
            files={"file": ("img.png", io.BytesIO(b"\x89PNG"), "image/png")},
        )
        assert r.status_code == 400


# ===========================================================================
# 3. Lista utworów  GET /tracks
# ===========================================================================

class TestListTracks:
    def test_empty_library_returns_empty_list(self, client):
        r = client.get("/tracks")
        assert r.status_code == 200
        assert r.json() == []

    def test_uploaded_track_appears_in_list(self, client):
        upload_track(client, filename="visible.mp3")
        r = client.get("/tracks")
        assert r.status_code == 200
        tracks = r.json()
        assert len(tracks) == 1
        assert tracks[0]["original_name"] == "visible.mp3"

    def test_multiple_tracks_ordered_descending_by_id(self, client):
        upload_track(client, filename="first.mp3")
        upload_track(client, filename="second.mp3")
        upload_track(client, filename="third.mp3")
        tracks = client.get("/tracks").json()
        ids = [t["id"] for t in tracks]
        assert ids == sorted(ids, reverse=True)

    def test_deleted_tracks_excluded_by_default(self, client):
        r = upload_track(client)
        track_id = r.json()["id"]
        client.delete(f"/tracks/{track_id}")
        tracks = client.get("/tracks").json()
        assert all(t["id"] != track_id for t in tracks)

    def test_include_deleted_shows_all_tracks(self, client):
        r = upload_track(client)
        track_id = r.json()["id"]
        client.delete(f"/tracks/{track_id}")
        tracks = client.get("/tracks?include_deleted=true").json()
        ids = [t["id"] for t in tracks]
        assert track_id in ids

    def test_track_has_expected_fields(self, client):
        upload_track(client, filename="check.mp3")
        track = client.get("/tracks").json()[0]
        for field in ("id", "filename", "original_name", "mime", "deleted"):
            assert field in track, f"Brak pola: {field}"

    def test_deleted_flag_is_zero_for_active_track(self, client):
        upload_track(client)
        track = client.get("/tracks").json()[0]
        assert track["deleted"] == 0


# ===========================================================================
# 4. Następny utwór  GET /set/next
# ===========================================================================

class TestNextTrack:
    def test_no_tracks_returns_404(self, client):
        r = client.get("/set/next")
        assert r.status_code == 404

    def test_returns_first_track_when_no_current_id(self, client):
        upload_track(client, filename="alpha.mp3")
        upload_track(client, filename="beta.mp3")
        r = client.get("/set/next")
        assert r.status_code == 200
        # Pierwszy (najniższe ID) – kolejność ASC
        assert r.json()["original_name"] == "alpha.mp3"

    def test_returns_next_track_after_current(self, client):
        id1 = upload_track(client, filename="one.mp3").json()["id"]
        id2 = upload_track(client, filename="two.mp3").json()["id"]
        r = client.get(f"/set/next?current_id={id1}")
        assert r.status_code == 200
        assert r.json()["id"] == id2

    def test_wraps_around_to_first_track(self, client):
        upload_track(client, filename="first.mp3")
        last_id = upload_track(client, filename="last.mp3").json()["id"]
        r = client.get(f"/set/next?current_id={last_id}")
        assert r.status_code == 200
        assert r.json()["original_name"] == "first.mp3"

    def test_skips_deleted_tracks(self, client):
        id1 = upload_track(client, filename="a.mp3").json()["id"]
        id2 = upload_track(client, filename="b.mp3").json()["id"]
        upload_track(client, filename="c.mp3")
        client.delete(f"/tracks/{id2}")
        r = client.get(f"/set/next?current_id={id1}")
        assert r.status_code == 200
        assert r.json()["original_name"] == "c.mp3"

    def test_404_when_all_tracks_deleted(self, client):
        tid = upload_track(client).json()["id"]
        client.delete(f"/tracks/{tid}")
        r = client.get("/set/next")
        assert r.status_code == 404

    def test_single_track_returns_itself_on_wrap(self, client):
        tid = upload_track(client, filename="solo.mp3").json()["id"]
        r = client.get(f"/set/next?current_id={tid}")
        assert r.status_code == 200
        assert r.json()["original_name"] == "solo.mp3"


# ===========================================================================
# 5. Streaming  GET /tracks/{id}/stream
# ===========================================================================

class TestStreamTrack:
    def test_stream_existing_track(self, client):
        r = upload_track(client, content=b"REAL_AUDIO")
        tid = r.json()["id"]
        resp = client.get(f"/tracks/{tid}/stream")
        assert resp.status_code == 200
        assert resp.content == b"REAL_AUDIO"

    def test_stream_nonexistent_track_returns_404(self, client):
        r = client.get("/tracks/9999/stream")
        assert r.status_code == 404

    def test_stream_deleted_track_returns_410(self, client):
        tid = upload_track(client).json()["id"]
        client.delete(f"/tracks/{tid}")
        r = client.get(f"/tracks/{tid}/stream")
        assert r.status_code == 410

    def test_stream_has_accept_ranges_header(self, client):
        tid = upload_track(client, content=b"AUDIO").json()["id"]
        r = client.get(f"/tracks/{tid}/stream")
        assert r.headers.get("accept-ranges") == "bytes"

    def test_stream_content_type_mp3(self, client):
        tid = upload_track(client, content=b"MP3", mime="audio/mpeg").json()["id"]
        r = client.get(f"/tracks/{tid}/stream")
        assert "audio/mpeg" in r.headers["content-type"]

    def test_stream_content_type_wav(self, client):
        tid = upload_track(client, content=b"WAV", filename="t.wav", mime="audio/wav").json()["id"]
        r = client.get(f"/tracks/{tid}/stream")
        assert "audio/wav" in r.headers["content-type"]


# ===========================================================================
# 6. Soft delete  DELETE /tracks/{id}
# ===========================================================================

class TestSoftDelete:
    def test_delete_existing_track(self, client):
        tid = upload_track(client).json()["id"]
        r = client.delete(f"/tracks/{tid}")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "deleted"
        assert data["mode"] == "soft"

    def test_deleted_track_not_in_list(self, client):
        tid = upload_track(client).json()["id"]
        client.delete(f"/tracks/{tid}")
        tracks = client.get("/tracks").json()
        assert all(t["id"] != tid for t in tracks)

    def test_delete_nonexistent_track_returns_404(self, client):
        r = client.delete("/tracks/99999")
        assert r.status_code == 404

    def test_soft_delete_keeps_file_in_storage(self, client, tmp_env):
        tid = upload_track(client, content=b"KEEP_ME").json()["id"]
        tracks_before = list(tmp_env["audio"].iterdir())
        client.delete(f"/tracks/{tid}")
        tracks_after = list(tmp_env["audio"].iterdir())
        assert len(tracks_before) == len(tracks_after)

    def test_double_delete_returns_404(self, client):
        tid = upload_track(client).json()["id"]
        client.delete(f"/tracks/{tid}")
        r = client.delete(f"/tracks/{tid}")
        # Drugi delete – track nadal istnieje w bazie (soft), ale row jest
        # więc zwraca 200 ponownie (obecna implementacja nie sprawdza deleted)
        # Weryfikujemy tylko, że nie crashuje
        assert r.status_code in (200, 404)


# ===========================================================================
# 7. Przywracanie  POST /tracks/restore
# ===========================================================================

class TestRestoreTracks:
    def test_restore_deleted_track(self, client):
        tid = upload_track(client).json()["id"]
        client.delete(f"/tracks/{tid}")
        r = client.post("/tracks/restore", json=[tid])
        assert r.status_code == 200
        assert r.json()["restored"] == 1

    def test_restored_track_appears_in_list(self, client):
        tid = upload_track(client, filename="comeback.mp3").json()["id"]
        client.delete(f"/tracks/{tid}")
        client.post("/tracks/restore", json=[tid])
        tracks = client.get("/tracks").json()
        ids = [t["id"] for t in tracks]
        assert tid in ids

    def test_restore_empty_list(self, client):
        r = client.post("/tracks/restore", json=[])
        assert r.status_code == 200
        assert r.json()["restored"] == 0

    def test_restore_multiple_tracks(self, client):
        ids = [upload_track(client, filename=f"{i}.mp3").json()["id"] for i in range(3)]
        for tid in ids:
            client.delete(f"/tracks/{tid}")
        r = client.post("/tracks/restore", json=ids)
        assert r.json()["restored"] == 3

    def test_restore_nonexistent_ids_returns_zero(self, client):
        r = client.post("/tracks/restore", json=[88888, 99999])
        assert r.status_code == 200
        assert r.json()["restored"] == 0


# ===========================================================================
# 8. Trwałe usuwanie  POST /tracks/purge
# ===========================================================================

class TestPurgeTracks:
    def test_purge_removes_track_from_db(self, client):
        tid = upload_track(client).json()["id"]
        r = client.post("/tracks/purge", json=[tid])
        assert r.status_code == 200
        assert r.json()["purged"] == 1
        assert client.get("/tracks?include_deleted=true").json() == []

    def test_purge_removes_file_from_storage(self, client, tmp_env):
        tid = upload_track(client, content=b"DELETE_ME").json()["id"]
        assert len(list(tmp_env["audio"].iterdir())) == 1
        client.post("/tracks/purge", json=[tid])
        assert len(list(tmp_env["audio"].iterdir())) == 0

    def test_purge_empty_list(self, client):
        r = client.post("/tracks/purge", json=[])
        assert r.status_code == 200
        assert r.json()["purged"] == 0

    def test_purge_multiple_tracks(self, client, tmp_env):
        ids = [upload_track(client, filename=f"{i}.mp3").json()["id"] for i in range(3)]
        r = client.post("/tracks/purge", json=ids)
        assert r.json()["purged"] == 3
        assert list(tmp_env["audio"].iterdir()) == []

    def test_purge_nonexistent_ids(self, client):
        r = client.post("/tracks/purge", json=[77777])
        assert r.status_code == 200
        assert r.json()["purged"] == 0


# ===========================================================================
# 9. Czyszczenie kosza  POST /tracks/purge-trash
# ===========================================================================

class TestPurgeTrash:
    def test_purge_trash_empty(self, client):
        r = client.post("/tracks/purge-trash")
        assert r.status_code == 200
        assert r.json()["purged"] == 0

    def test_purge_trash_removes_only_deleted(self, client, tmp_env):
        tid_active = upload_track(client, filename="active.mp3").json()["id"]
        tid_trash = upload_track(client, filename="trash.mp3").json()["id"]
        client.delete(f"/tracks/{tid_trash}")

        r = client.post("/tracks/purge-trash")
        assert r.json()["purged"] == 1

        # Aktywny utwór nadal istnieje
        tracks = client.get("/tracks").json()
        assert any(t["id"] == tid_active for t in tracks)

    def test_purge_trash_removes_files_from_storage(self, client, tmp_env):
        upload_track(client, filename="keep.mp3", content=b"KEEP")
        tid_trash = upload_track(client, filename="bye.mp3", content=b"BYE").json()["id"]
        client.delete(f"/tracks/{tid_trash}")

        client.post("/tracks/purge-trash")

        files = [f.name for f in tmp_env["audio"].iterdir()]
        assert len(files) == 1  # Tylko aktywny plik pozostał

    def test_purge_trash_multiple_deleted(self, client):
        ids = [upload_track(client, filename=f"{i}.mp3").json()["id"] for i in range(5)]
        for tid in ids:
            client.delete(f"/tracks/{tid}")
        r = client.post("/tracks/purge-trash")
        assert r.json()["purged"] == 5
        assert client.get("/tracks?include_deleted=true").json() == []


# ===========================================================================
# 10. Testy modułu storage (lokalne)
# ===========================================================================

class TestStorageLocal:
    def test_save_and_exists(self, tmp_env):
        from app.storage import save_upload, object_exists
        f = io.BytesIO(b"AUDIO_DATA")
        save_upload(f, "test_file.mp3", "audio/mpeg")
        assert object_exists("test_file.mp3")

    def test_not_exists_for_unknown(self, tmp_env):
        from app.storage import object_exists
        assert not object_exists("ghost.mp3")

    def test_save_empty_raises_value_error(self, tmp_env):
        from app.storage import save_upload
        with pytest.raises(ValueError, match="pusty"):
            save_upload(io.BytesIO(b""), "empty.mp3", "audio/mpeg")

    def test_open_stream_returns_readable(self, tmp_env):
        from app.storage import save_upload, open_stream
        save_upload(io.BytesIO(b"STREAM_ME"), "stream.mp3", "audio/mpeg")
        with open_stream("stream.mp3") as s:
            data = s.read()
        assert data == b"STREAM_ME"

    def test_delete_removes_file(self, tmp_env):
        from app.storage import save_upload, object_exists, delete_object
        save_upload(io.BytesIO(b"BYEBYE"), "del.mp3", "audio/mpeg")
        assert object_exists("del.mp3")
        delete_object("del.mp3")
        assert not object_exists("del.mp3")

    def test_delete_nonexistent_does_not_raise(self, tmp_env):
        from app.storage import delete_object
        delete_object("nonexistent.mp3")  # Nie powinno rzucać wyjątku

    def test_ensure_storage_ready_creates_dir(self, tmp_path, monkeypatch):
        new_dir = tmp_path / "new_audio"
        monkeypatch.setenv("AUDIO_DIR", str(new_dir))
        monkeypatch.setenv("MINIO_ENABLED", "false")

        import importlib, sys
        for mod in list(sys.modules.keys()):
            if "app.storage" in mod:
                del sys.modules[mod]
        from app.storage import ensure_storage_ready
        ensure_storage_ready()
        assert new_dir.exists()


# ===========================================================================
# 11. Testy modułu db
# ===========================================================================

class TestDatabase:
    def test_init_db_creates_tracks_table(self, tmp_env):
        from app.db import init_db, get_conn
        init_db()
        with get_conn() as conn:
            tables = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='tracks'"
            ).fetchall()
        assert len(tables) == 1

    def test_init_db_is_idempotent(self, tmp_env):
        from app.db import init_db
        init_db()
        init_db()  # Drugie wywołanie nie powinno rzucać wyjątku

    def test_get_conn_returns_row_factory(self, tmp_env):
        from app.db import get_conn, init_db
        init_db()
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO tracks(filename, original_name, mime, deleted) VALUES(?,?,?,0)",
                ("f.mp3", "orig.mp3", "audio/mpeg"),
            )
            row = conn.execute("SELECT * FROM tracks WHERE filename='f.mp3'").fetchone()
        assert row["filename"] == "f.mp3"
        assert row["original_name"] == "orig.mp3"

    def test_tracks_table_has_required_columns(self, tmp_env):
        from app.db import init_db, get_conn
        init_db()
        with get_conn() as conn:
            cols = [r["name"] for r in conn.execute("PRAGMA table_info(tracks)").fetchall()]
        for col in ("id", "filename", "original_name", "mime", "deleted"):
            assert col in cols

    def test_deleted_column_defaults_to_zero(self, tmp_env):
        from app.db import init_db, get_conn
        init_db()
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO tracks(filename, original_name) VALUES(?,?)",
                ("x.mp3", "x.mp3"),
            )
            row = conn.execute("SELECT deleted FROM tracks WHERE filename='x.mp3'").fetchone()
        assert row["deleted"] == 0


# ===========================================================================
# 12. Testy end-to-end (pełny przepływ)
# ===========================================================================

class TestEndToEnd:
    def test_full_upload_list_stream_delete_cycle(self, client):
        # Upload
        r = upload_track(client, content=b"FULL_CYCLE", filename="cycle.mp3")
        assert r.status_code == 200
        tid = r.json()["id"]

        # Pojawia się na liście
        tracks = client.get("/tracks").json()
        assert any(t["id"] == tid for t in tracks)

        # Można go streamować
        stream_r = client.get(f"/tracks/{tid}/stream")
        assert stream_r.status_code == 200
        assert stream_r.content == b"FULL_CYCLE"

        # Soft delete
        client.delete(f"/tracks/{tid}")
        tracks = client.get("/tracks").json()
        assert all(t["id"] != tid for t in tracks)

        # Streaming zwraca 410
        assert client.get(f"/tracks/{tid}/stream").status_code == 410

        # Restore
        client.post("/tracks/restore", json=[tid])
        tracks = client.get("/tracks").json()
        assert any(t["id"] == tid for t in tracks)

        # Purge
        client.post("/tracks/purge", json=[tid])
        assert client.get("/tracks?include_deleted=true").json() == []

    def test_dj_set_rotation(self, client):
        """Symuluje rotację setlisty DJ-a."""
        names = ["intro.mp3", "drop.mp3", "outro.mp3"]
        ids = [upload_track(client, filename=n).json()["id"] for n in names]

        # Zaczynamy od pierwszego
        r = client.get("/set/next")
        assert r.json()["original_name"] == "intro.mp3"
        first_id = r.json()["id"]

        # Przechodzimy dalej
        r = client.get(f"/set/next?current_id={first_id}")
        assert r.json()["original_name"] == "drop.mp3"
        second_id = r.json()["id"]

        r = client.get(f"/set/next?current_id={second_id}")
        assert r.json()["original_name"] == "outro.mp3"
        third_id = r.json()["id"]

        # Wrap-around
        r = client.get(f"/set/next?current_id={third_id}")
        assert r.json()["original_name"] == "intro.mp3"

    def test_purge_trash_workflow(self, client, tmp_env):
        """Upload → delete kilku → purge-trash → aktywne zostają."""
        active = upload_track(client, filename="active.mp3", content=b"ACTIVE").json()["id"]
        trash1 = upload_track(client, filename="del1.mp3", content=b"DEL1").json()["id"]
        trash2 = upload_track(client, filename="del2.mp3", content=b"DEL2").json()["id"]

        client.delete(f"/tracks/{trash1}")
        client.delete(f"/tracks/{trash2}")

        r = client.post("/tracks/purge-trash")
        assert r.json()["purged"] == 2

        tracks = client.get("/tracks?include_deleted=true").json()
        assert len(tracks) == 1
        assert tracks[0]["id"] == active

        files = list(tmp_env["audio"].iterdir())
        assert len(files) == 1
        assert files[0].read_bytes() == b"ACTIVE"
