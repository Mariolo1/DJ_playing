import React, { useEffect, useRef, useState } from "react";
import "./App.css";

const DEFAULT_MIX_INTERVAL_SEC = 70;
const DEFAULT_FADE_SEC = 10;

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

export default function App() {
  const [tracks, setTracks] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  const [isRunning, setIsRunning] = useState(false);
  const [targetEnergy, setTargetEnergy] = useState(0.65);
  const [mixIntervalSec, setMixIntervalSec] = useState(DEFAULT_MIX_INTERVAL_SEC);
  const [fadeSec, setFadeSec] = useState(DEFAULT_FADE_SEC);

  const [nowPlaying, setNowPlaying] = useState(null);
  const [nextUp, setNextUp] = useState(null);

  // PRO
  const [showTrash, setShowTrash] = useState(false);
  const [selected, setSelected] = useState(new Set()); // track ids

  const historyRef = useRef([]);
  const audioCtxRef = useRef(null);
  const gainARef = useRef(null);
  const gainBRef = useRef(null);
  const deckARef = useRef(null);
  const deckBRef = useRef(null);
  const activeDeckRef = useRef("A");
  const timerRef = useRef(null);

  async function apiGet(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }

  async function apiPostJson(path, obj) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(obj),
    });
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }

  async function apiPostForm(path, body) {
    const res = await fetch(path, { method: "POST", body });
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }

  async function apiDelete(path) {
    const res = await fetch(path, { method: "DELETE" });
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }

  async function refreshTracks(nextShowTrash = showTrash) {
    const list = await apiGet(`/tracks?include_deleted=${nextShowTrash ? "true" : "false"}`);
    // jak showTrash=true pokazujemy wszystko, ale UI filtruje:
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

  async function fetchNext(currentId) {
    const history = historyRef.current.join(",");
    const params = new URLSearchParams();
    if (currentId !== null && currentId !== undefined) params.set("current_id", String(currentId));
    params.set("target_energy", String(targetEnergy));
    params.set("history", history);
    return await apiGet(`/set/next?${params.toString()}`);
  }

  useEffect(() => {
    if (!isRunning || !nowPlaying) return;
    fetchNext(nowPlaying.id).then(setNextUp).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetEnergy]);

  function stopTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  useEffect(() => {
    if (!isRunning) return;
    stopTimer();
    timerRef.current = setInterval(() => {
      doTransition().catch(console.error);
    }, mixIntervalSec * 1000);
    return () => stopTimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, mixIntervalSec]);

  async function stopSet() {
    stopTimer();
    setIsRunning(false);
    setNowPlaying(null);
    setNextUp(null);
    historyRef.current = [];

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

    const active = tracks.filter((t) => (t.deleted || 0) === 0);
    const analyzed = active.filter((t) => t.analyzed === 1);

    if (analyzed.length < 2) {
      alert("Najpierw wrzuć i przeanalizuj co najmniej 2 utwory (Analyze).");
      return;
    }

    historyRef.current = [];
    activeDeckRef.current = "A";

    try {
      const first = await fetchNext(null);
      historyRef.current.push(first.id);
      setNowPlaying(first);

      const deckA = deckARef.current;
      deckA.src = `/tracks/${first.id}/stream`;
      deckA.playbackRate = 1.0;
      await deckA.play();

      const next = await fetchNext(first.id);
      setNextUp(next);

      const deckB = deckBRef.current;
      deckB.src = `/tracks/${next.id}/stream`;
      deckB.playbackRate = 1.0;
      deckB.load();

      setIsRunning(true);
    } catch (e) {
      alert("Start error: " + e.message);
    }
  }

  async function doTransition() {
    if (!isRunning || !nowPlaying || !nextUp) return;

    const deckA = deckARef.current;
    const deckB = deckBRef.current;
    const gainA = gainARef.current;
    const gainB = gainBRef.current;

    const active = activeDeckRef.current;
    const fromDeck = active === "A" ? deckA : deckB;
    const toDeck = active === "A" ? deckB : deckA;
    const fromGain = active === "A" ? gainA : gainB;
    const toGain = active === "A" ? gainB : gainA;

    const fromBpm = nowPlaying.bpm || 120;
    const toBpm = nextUp.bpm || 120;
    const rate = clamp(fromBpm / toBpm, 0.85, 1.15);
    toDeck.playbackRate = rate;

    if (toDeck.paused) await toDeck.play();

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
        fromDeck.pause();
        fromDeck.currentTime = 0;
      } catch {}

      activeDeckRef.current = active === "A" ? "B" : "A";

      setNowPlaying(nextUp);
      historyRef.current.push(nextUp.id);

      const newNext = await fetchNext(nextUp.id);
      setNextUp(newNext);

      const inactiveDeck = active === "A" ? deckA : deckB;
      inactiveDeck.src = `/tracks/${newNext.id}/stream`;
      inactiveDeck.playbackRate = 1.0;
      inactiveDeck.load();
    }, fadeSec * 1000 + 200);
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
          <span>Energy target: {targetEnergy.toFixed(2)}</span>
          <input type="range" min="0" max="1" step="0.01" value={targetEnergy} onChange={(e) => setTargetEnergy(parseFloat(e.target.value))} />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>Mix interval (s): {mixIntervalSec}</span>
          <input type="range" min="15" max="180" step="5" value={mixIntervalSec} onChange={(e) => setMixIntervalSec(parseInt(e.target.value, 10))} />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>Fade (s): {fadeSec}</span>
          <input type="range" min="4" max="20" step="1" value={fadeSec} onChange={(e) => setFadeSec(parseInt(e.target.value, 10))} />
        </label>
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ opacity: 0.85, fontSize: 13 }}>
          Widoczne: {visibleTracks.length} | zaznaczone: {selected.size}
        </div>

        <button onClick={selectAllVisible} disabled={visibleTracks.length === 0}>Zaznacz wszystko</button>
        <button onClick={clearSelection} disabled={selected.size === 0}>Wyczyść zaznaczenie</button>

        {!showTrash ? (
          <>
            <button onClick={softDeleteSelected} disabled={selected.size === 0 || isRunning}>
              🗑 Do kosza
            </button>
          </>
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

      <div style={{ fontWeight: 800, marginBottom: 8 }}>
        Track list {showTrash ? "(Kosz)" : "(Biblioteka)"}
      </div>

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
              const disabled = playingIds.has(t.id) || isRunning; // blokada dla grających
              return (
                <tr key={t.id} style={{ opacity: disabled ? 0.75 : 1 }}>
                  <td style={{ padding: 10, borderBottom: "1px solid #f3f3f3" }}>
                    <input
                      type="checkbox"
                      checked={selected.has(t.id)}
                      onChange={() => toggleSelect(t.id)}
                      disabled={disabled && !showTrash} // w bibliotece blokujemy zaznaczenie grających
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
        PRO: Kosz + multi-select. MVP sync: playbackRate (tempo+pitch). V2: prawdziwy time-stretch.
      </div>
    </div>
  );
}