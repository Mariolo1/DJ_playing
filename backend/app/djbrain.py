from __future__ import annotations
import math
import random
import sqlite3

def pick_next(
    conn: sqlite3.Connection,
    current_id: int | None,
    target_energy: float,
    history: list[int],
) -> dict | None:
    rows = conn.execute(
        "SELECT * FROM tracks WHERE analyzed=1 AND (deleted IS NULL OR deleted=0)"
    ).fetchall()
    if not rows:
        return None

    current = None
    if current_id is not None:
        current = conn.execute("SELECT * FROM tracks WHERE id=?", (current_id,)).fetchone()

    def score(r) -> float:
        # Nie wybieraj bieżącego tracka ani nic z historii
        if (current_id is not None and r["id"] == current_id) or (r["id"] in history):
            return -1e9

        s = 0.0

        r_energy = float(r["energy"] or 0.0)
        s += 2.0 * (1.0 - abs(r_energy - target_energy))

        if current and current["bpm"] and r["bpm"]:
            diff = abs(float(r["bpm"]) - float(current["bpm"]))
            s += 2.0 * math.exp(-(diff / 6.0) ** 2)

        if r["duration"]:
            s += 0.2 * min(float(r["duration"]) / 240.0, 1.0)

        s += random.uniform(-0.05, 0.05)
        return s

    scored = [(score(r), r) for r in rows]
    scored.sort(key=lambda x: x[0], reverse=True)

    # odfiltruj zablokowane (-1e9)
    scored = [x for x in scored if x[0] > -1e8]
    if not scored:
        return None

    # losuj z TOP-5, żeby nie kleiło się do jednego utworu
    K = min(5, len(scored))
    _, chosen = random.choice(scored[:K])
    return dict(chosen)