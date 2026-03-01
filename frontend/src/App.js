import React, { useEffect, useRef, useState } from "react";
import "./App.css";

const DEFAULT_MIX_INTERVAL_SEC = 70;
const DEFAULT_FADE_SEC = 10;

// Backend URL z .env (dla laptopa + serwer):
// frontend/.env -> REACT_APP_API_URL=http://IP_SERWERA:8000
const API_BASE = process.env.REACT_APP_API_URL || "http://localhost:8000";

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

export default function App() {
  const [tracks, setTracks] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  const [isRunning, setIsRunning] = useState(false);
  const [targetEnergy, setTargetEnergy] = useState(0.65); // tylko UI
  const [mixIntervalSec, setMixIntervalSec] = useState(DEFAULT_MIX_INTERVAL_SEC);
  const [fadeSec, setFadeSec] = useState(DEFAULT_FADE_SEC);

  const [nowPlaying, setNowPlaying] = useState(null);
  const [nextUp, setNextUp] = useState(null);

  // PRO
  const [showTrash, setShowTrash] = useState(false);
  const [selected, setSelected] = useState(new Set()); // track ids

  // audio
  const audioCtxRef = useRef(null);
  const gainARef = useRef(null);
  const gainBRef = useRef(null);
  const deckARef = useRef(null);
  const deckBRef = useRef(null);
  const activeDeckRef = useRef("A");

  // timer + transition guard
  const timerRef = useRef(null);
  const transitioningRef = useRef(false);

  // STABILNA PLAYLISTA (zamrożona na start)
  const playlistRef = useRef([]); // [{id,...}, ...] posortowane po ID
  const indexRef = useRef(0); // index aktualnego "now playing" w playlistRef

  // ------- API helpers -------
  async function apiGet(path) {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }

  async function apiPostJson(path, obj) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(obj),
    });
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }

  async function apiPostForm(path, body) {
    const res = await fetch(`${API_BASE}${path}`, { method: "POST", body });
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }

  async function apiDelete(path) {
    const res = await fetch(`${API_BASE}${path}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }

  async function refreshTracks(nextShowTrash = showTrash) {
    const list = await apiGet(`/tracks?include_deleted=${nextShowTrash ? "true" : "false"}`);
    setTracks(list);
  }

  useEffect(() => {
    refreshTracks().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refreshTracks(showTrash).catch(console.error);
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTrash]);

  // ------- playlist builder (ID rosnąco) -------
  function buildPlaylistFromTracks() {
    return tracks
      .filter((t) => (t.deleted || 0) === 0 && t.analyzed === 1)
      .sort((a, b) => a.id - b.id);
  }

  // ------- audio graph -------
  function ensureAudioGraph() {
    if (audioCtxRef.current) return;

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = ctx;

    const sourceA = ctx.createMediaElementSource(deckARef.current);
    const sourceB = ctx.createMediaElementSource(deckBRef.current);

    const gainA = ctx.createGain();
    const gainB = ctx.createGain();

    gainA.gain.value = 1.0;
    gainB.gain.value = 0.0;

    sourceA.connect(gainA).connect(ctx.destination);
    sourceB.connect(gainB).connect(ctx.destination);

    gainARef.current = gainA;
    gainBRef.current = gainB;
  }

  // ------- timer: łańcuch setTimeout (bez setInterval) -------
  function stopTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  useEffect(() => {
    if (!isRunning) return;

    stopTimer();
    const schedule = () => {
      timerRef.current = setTimeout(async () => {
        await doTransition().catch(console.error);
        schedule();
      }, mixIntervalSec * 1000);
    };

    schedule();
    return () => stopTimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, mixIntervalSec]);

  // ------- ended event: gdy utwór skończy się wcześniej niż mixInterval -------
  useEffect(() => {
    const a = deckARef.current;
    const b = deckBRef.current;
    if (!a || !b) return;

    const onEndedA = () => {
      if (isRunning && activeDeckRef.current === "A") doTransition().catch(console.error);
    };
    const onEndedB = () => {
      if (isRunning && activeDeckRef.current === "B") doTransition().catch(console.error);
    };

    a.addEventListener("ended", onEndedA);
    b.addEventListener("ended", onEndedB);

    return () => {
      a.removeEventListener("ended", onEndedA);
      b.removeEventListener("ended", onEndedB);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, nowPlaying, nextUp, fadeSec, mixIntervalSec]);

  // ------- actions -------
  async function handleUpload(files) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const f of files) {
        const form = new FormData();
        form.append("file", f);
        await apiPostForm("/tracks/upload", form);
      }
      await refreshTracks(showTrash);
    } catch (e) {
      alert("Upload error: " + e.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleAnalyze() {
    setAnalyzing(true);
    try {
      await apiPostForm("/tracks/analyze", null);
      await refreshTracks(showTrash);
    } catch (e) {
      alert("Analyze error: " + e.message);
    } finally {
      setAnalyzing(false);
    }
  }

  async function stopSet() {
    stopTimer();
    setIsRunning(false);
    setNowPlaying(null);
    setNextUp(null);
    transitioningRef.current = false;

    // wyczyść playlistę
    playlistRef.current = [];
    indexRef.current = 0;

    try {
      deckARef.current?.pause();
      deckBRef.current?.pause();
      if (deckARef.current) deckARef.current.currentTime = 0;
      if (deckBRef.current) deckBRef.current.currentTime = 0;
      if (gainARef.current) gainARef.current.gain.value = 1;
      if (gainBRef.current) gainBRef.current.gain.value = 0;
      activeDeckRef.current = "A";
    } catch {}
  }

  async function startSet() {
    ensureAudioGraph();
    await audioCtxRef.current.resume();

    const list = buildPlaylistFromTracks();
    if (list.length < 2) {
      alert("Potrzebujesz co najmniej 2 aktywnych i przeanalizowanych utworów.");
      return;
    }

    playlistRef.current = list;
    indexRef.current = 0;
    activeDeckRef.current = "A";
    transitioningRef.current = false;

    try {
      const first = list[0];
      const second = list[1];

      setNowPlaying(first);
      setNextUp(second);

      const deckA = deckARef.current;
      deckA.src = `${API_BASE}/tracks/${first.id}/stream`;
      deckA.playbackRate = 1.0;

      try {
        await deckA.play();
      } catch (e) {
        console.error("deckA.play failed", e);
        alert("Nie mogę rozpocząć odtwarzania (play blocked). Kliknij jeszcze raz START SET.");
        return;
      }

      const deckB = deckBRef.current;
      deckB.src = `${API_BASE}/tracks/${second.id}/stream`;
      deckB.playbackRate = 1.0;
      deckB.load();

      setIsRunning(true);
    } catch (e) {
      alert("Start error: " + e.message);
    }
  }

  async function doTransition() {
    if (!isRunning || !nowPlaying || !nextUp) return;
    if (transitioningRef.current) return;
    transitioningRef.current = true;

    try {
      const deckA = deckARef.current;
      const deckB = deckBRef.current;
      const gainA = gainARef.current;
      const gainB = gainBRef.current;

      const active = activeDeckRef.current;
      const fromDeck = active === "A" ? deckA : deckB;
      const toDeck = active === "A" ? deckB : deckA;
      const fromGain = active === "A" ? gainA : gainB;
      const toGain = active === "A" ? gainB : gainA;

      // tempo sync (kosmetyczne)
      const fromBpm = nowPlaying.bpm || 120;
      const list = playlistRef.current;
      const currentNext = list && list.length > 1 ? list[(indexRef.current + 1) % list.length] : nextUp;
      const toBpm = currentNext?.bpm || 120;
      const rate = clamp(fromBpm / toBpm, 0.85, 1.15);
      toDeck.playbackRate = rate;

      if (toDeck.paused) {
        try {
          await toDeck.play();
        } catch (e) {
          console.error("toDeck.play failed", e);
        }
      }

      const ctx = audioCtxRef.current;
      const now = ctx.currentTime;

      fromGain.gain.cancelScheduledValues(now);
      toGain.gain.cancelScheduledValues(now);

      fromGain.gain.setValueAtTime(fromGain.gain.value, now);
      toGain.gain.setValueAtTime(toGain.gain.value, now);

      fromGain.gain.linearRampToValueAtTime(0.0, now + fadeSec);
      toGain.gain.linearRampToValueAtTime(1.0, now + fadeSec);

      setTimeout(async () => {
        try {
          try {
            fromDeck.pause();
            fromDeck.currentTime = 0;
          } catch {}

          activeDeckRef.current = active === "A" ? "B" : "A";

          // --- przesuń indeks w zamrożonej playliście ---
          const list2 = playlistRef.current;
          if (!list2 || list2.length < 2) {
            stopSet();
            return;
          }

          // przechodzimy na kolejny utwór (źródło prawdy = playlistRef)
          indexRef.current = (indexRef.current + 1) % list2.length;

          const nowTrack = list2[indexRef.current];
          const nextIndex = (indexRef.current + 1) % list2.length;
          const newNext = list2[nextIndex];

          // ✅ UI aktualizujemy z playlisty
          setNowPlaying(nowTrack);
          setNextUp(newNext);

          // --- załaduj newNext na nieaktywny deck ---
          const inactiveDeck = active === "A" ? deckA : deckB;
          inactiveDeck.src = `${API_BASE}/tracks/${newNext.id}/stream`;
          inactiveDeck.playbackRate = 1.0;
          inactiveDeck.load();
        } catch (e) {
          console.error("transition callback failed", e);
          alert("Błąd przejścia: " + (e?.message || e));
          stopSet();
        } finally {
          transitioningRef.current = false;
        }
      }, fadeSec * 1000 + 200);
    } catch (e) {
      console.error("doTransition failed", e);
      alert("Błąd przejścia: " + (e?.message || e));
      stopSet();
      transitioningRef.current = false;
    }
  }

  // ---------- PRO: selection + kosz ----------
  const playingIds = new Set([nowPlaying?.id, nextUp?.id].filter(Boolean));

  const visibleTracks = showTrash
    ? tracks.filter((t) => (t.deleted || 0) === 1)
    : tracks.filter((t) => (t.deleted || 0) === 0);

  const analyzedCount = visibleTracks.filter((t) => t.analyzed === 1).length;

  function toggleSelect(id) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function selectAllVisible() {
    setSelected(new Set(visibleTracks.map((t) => t.id)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function blockIfPlaying(ids) {
    const bad = ids.filter((id) => playingIds.has(id));
    if (bad.length > 0) {
      alert("Nie można usunąć utworu który gra lub jest 'Next up'. Najpierw STOP.");
      return true;
    }
    return false;
  }

  async function softDeleteSelected() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;

    if (isRunning || blockIfPlaying(ids)) return;

    if (!window.confirm(`Przenieść do kosza: ${ids.length} utw.?`)) return;

    try {
      for (const id of ids) await apiDelete(`/tracks/${id}`);
      await refreshTracks(showTrash);
      clearSelection();
    } catch (e) {
      alert("Delete error: " + e.message);
    }
  }

  async function restoreSelected() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;

    if (!window.confirm(`Przywrócić: ${ids.length} utw.?`)) return;

    try {
      await apiPostJson("/tracks/restore", ids);
      await refreshTracks(showTrash);
      clearSelection();
    } catch (e) {
      alert("Restore error: " + e.message);
    }
  }

  async function purgeSelected() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;

    if (isRunning || blockIfPlaying(ids)) return;

    if (!window.confirm(`USUNĄĆ TRWALE: ${ids.length} utw.? (nieodwracalne)`)) return;

    try {
      await apiPostJson("/tracks/purge", ids);
      await refreshTracks(showTrash);
      clearSelection();
    } catch (e) {
      alert("Purge error: " + e.message);
    }
  }

  async function purgeTrash() {
    if (isRunning) {
      alert("Najpierw STOP (nie czyścimy kosza w trakcie seta).");
      return;
    }
    if (!window.confirm("Wyczyścić cały kosz? (nieodwracalne)")) return;

    try {
      await apiPostJson("/tracks/purge-trash", []);
      await refreshTracks(showTrash);
      clearSelection();
    } catch (e) {
      alert("Purge trash error: " + e.message);
    }
  }

  return (
    <div className="App" style={{ maxWidth: 1000, margin: "0 auto", padding: 16 }}>
      <h2>🕺 Auto-DJ (MVP/PRO) — lokalne MP3/WAV</h2>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="file"
          multiple
          accept=".mp3,.wav,audio/mpeg,audio/wav"
          disabled={uploading || isRunning}
          onChange={(e) => handleUpload(e.target.files)}
        />

        <button onClick={handleAnalyze} disabled={analyzing || isRunning}>
          {analyzing ? "Analyzing..." : "Analyze"}
        </button>

        {!isRunning ? (
          <button onClick={startSet} disabled={analyzedCount < 2 || uploading || analyzing || showTrash}>
            START SET
          </button>
        ) : (
          <button onClick={stopSet}>STOP</button>
        )}

        <label style={{ marginLeft: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={showTrash} onChange={(e) => setShowTrash(e.target.checked)} />
          Pokaż kosz
        </label>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 800 }}>Now playing</div>
          {nowPlaying ? (
            <>
              <div style={{ marginTop: 6 }}>{nowPlaying.original_name}</div>
              <div style={{ opacity: 0.8, fontSize: 13 }}>
                BPM: {nowPlaying.bpm?.toFixed?.(1) ?? "-"} | Energy: {nowPlaying.energy?.toFixed?.(2) ?? "-"}
              </div>
            </>
          ) : (
            <div style={{ opacity: 0.7, marginTop: 6 }}>—</div>
          )}
        </div>

        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 800 }}>Next up</div>
          {nextUp ? (
            <>
              <div style={{ marginTop: 6 }}>{nextUp.original_name}</div>
              <div style={{ opacity: 0.8, fontSize: 13 }}>
                BPM: {nextUp.bpm?.toFixed?.(1) ?? "-"} | Energy: {nextUp.energy?.toFixed?.(2) ?? "-"}
              </div>
            </>
          ) : (
            <div style={{ opacity: 0.7, marginTop: 6 }}>—</div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Energy target: {targetEnergy.toFixed(2)} (UI)</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={targetEnergy}
            onChange={(e) => setTargetEnergy(parseFloat(e.target.value))}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>Mix interval (s): {mixIntervalSec}</span>
          <input
            type="range"
            min="15"
            max="180"
            step="5"
            value={mixIntervalSec}
            onChange={(e) => setMixIntervalSec(parseInt(e.target.value, 10))}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>Fade (s): {fadeSec}</span>
          <input
            type="range"
            min="4"
            max="20"
            step="1"
            value={fadeSec}
            onChange={(e) => setFadeSec(parseInt(e.target.value, 10))}
          />
        </label>
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ opacity: 0.85, fontSize: 13 }}>
          Widoczne: {visibleTracks.length} | zaznaczone: {selected.size}
        </div>

        <button onClick={selectAllVisible} disabled={visibleTracks.length === 0}>
          Zaznacz wszystko
        </button>
        <button onClick={clearSelection} disabled={selected.size === 0}>
          Wyczyść zaznaczenie
        </button>

        {!showTrash ? (
          <button onClick={softDeleteSelected} disabled={selected.size === 0 || isRunning}>
            🗑 Do kosza
          </button>
        ) : (
          <>
            <button onClick={restoreSelected} disabled={selected.size === 0}>
              ♻ Przywróć
            </button>
            <button onClick={purgeSelected} disabled={selected.size === 0 || isRunning}>
              ❌ Usuń trwale
            </button>
            <button onClick={purgeTrash} disabled={visibleTracks.length === 0 || isRunning}>
              🧹 Wyczyść kosz
            </button>
          </>
        )}
      </div>

      <audio ref={deckARef} crossOrigin="anonymous" />
      <audio ref={deckBRef} crossOrigin="anonymous" />

      <hr style={{ margin: "16px 0" }} />

      <div style={{ fontWeight: 800, marginBottom: 8 }}>Track list {showTrash ? "(Kosz)" : "(Biblioteka)"}</div>

      <div style={{ maxHeight: 360, overflow: "auto", border: "1px solid #eee", borderRadius: 12 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", background: "#fafafa" }}>
              <th style={{ padding: 10, borderBottom: "1px solid #eee", width: 44 }}></th>
              <th style={{ padding: 10, borderBottom: "1px solid #eee" }}>Name</th>
              <th style={{ padding: 10, borderBottom: "1px solid #eee" }}>BPM</th>
              <th style={{ padding: 10, borderBottom: "1px solid #eee" }}>Energy</th>
              <th style={{ padding: 10, borderBottom: "1px solid #eee" }}>Analyzed</th>
              <th style={{ padding: 10, borderBottom: "1px solid #eee" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {visibleTracks.map((t) => {
              const disabled = playingIds.has(t.id) || isRunning;
              return (
                <tr key={t.id} style={{ opacity: disabled ? 0.75 : 1 }}>
                  <td style={{ padding: 10, borderBottom: "1px solid #f3f3f3" }}>
                    <input
                      type="checkbox"
                      checked={selected.has(t.id)}
                      onChange={() => toggleSelect(t.id)}
                      disabled={disabled && !showTrash}
                      title={disabled ? "Track gra / NextUp – STOP, aby usuwać" : ""}
                    />
                  </td>
                  <td style={{ padding: 10, borderBottom: "1px solid #f3f3f3" }}>{t.original_name}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #f3f3f3" }}>{t.bpm ? t.bpm.toFixed(1) : "-"}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #f3f3f3" }}>{t.energy != null ? t.energy.toFixed(2) : "-"}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #f3f3f3" }}>{t.analyzed === 1 ? "✅" : "—"}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #f3f3f3" }}>
                    {playingIds.has(t.id) ? "▶ playing/next" : showTrash ? "🗑 w koszu" : "OK"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
        Kolejność: ID rosnąco (zamrożona na START SET). Now/Next liczone z playlisty.
      </div>
    </div>
  );
}