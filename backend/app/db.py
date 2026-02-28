from __future__ import annotations
import sqlite3
from pathlib import Path

DB_PATH = Path("data/app.db")


def get_conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_conn() as c:
        # 1) tabela (nowa instalacja)
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS tracks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                original_name TEXT NOT NULL,
                mime TEXT,
                duration REAL,
                bpm REAL,
                energy REAL,
                analyzed INTEGER DEFAULT 0,
                deleted INTEGER DEFAULT 0
            );
            """
        )

        # 2) migracja dla starszych baz: dodaj kolumnę deleted jeśli jej nie ma
        cols = [r["name"] for r in c.execute("PRAGMA table_info(tracks)").fetchall()]
        if "deleted" not in cols:
            c.execute("ALTER TABLE tracks ADD COLUMN deleted INTEGER DEFAULT 0;")

        # 3) indeksy dopiero po migracji
        c.execute("CREATE INDEX IF NOT EXISTS idx_tracks_analyzed ON tracks(analyzed);")
        c.execute("CREATE INDEX IF NOT EXISTS idx_tracks_deleted ON tracks(deleted);")