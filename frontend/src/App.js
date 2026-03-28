import React, { useEffect, useRef, useState } from "react";
import "./App.css";

function App() {
  const [tracks, setTracks] = useState([]);
  const [showTrash, setShowTrash] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [currentTrack, setCurrentTrack] = useState(null);
  const [nextTrack, setNextTrack] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [playing, setPlaying] = useState(false);

  const [mixInterval, setMixInterval] = useState(70);
  const [fadeSeconds, setFadeSeconds] = useState(10);

  const audioRef = useRef(null);
  const transitionTimerRef = useRef(null);
  const fadeTimerRef = useRef(null);

  async function refreshTracks(includeDeleted = showTrash) {
    const res = await fetch(`/tracks?include_deleted=${includeDeleted}`);
    if (!res.ok) {
      throw new Error("Nie udało się pobrać listy utworów.");
    }
    const data = await res.json();
    setTracks(data);
  }

  async function refreshNext(currentId = null) {
    try {
      const url =
        currentId == null
          ? `/set/next`
          : `/set/next?current_id=${encodeURIComponent(currentId)}`;

      const res = await fetch(url);
      if (!res.ok) {
        setNextTrack(null);
        return;
      }

      const data = await res.json();
      setNextTrack(data);
    } catch {
      setNextTrack(null);
    }
  }

  function clearTimers() {
    if (transitionTimerRef.current) {
      clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
    if (fadeTimerRef.current) {
      clearInterval(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
  }

  function startFadeAndTransition() {
    const audio = audioRef.current;
    if (!audio || !nextTrack) return;

    clearTimers();

    const fadeMs = Math.max(0, Number(fadeSeconds) || 0) * 1000;
    const steps = 20;
    const stepMs = fadeMs > 0 ? Math.max(50, Math.floor(fadeMs / steps)) : 0;
    const initialVolume = 1;

    audio.volume = initialVolume;

    if (fadeMs > 0) {
      let currentStep = 0;
      fadeTimerRef.current = setInterval(() => {
        currentStep += 1;
        const nextVolume = Math.max(0, initialVolume * (1 - currentStep / steps));
        audio.volume = nextVolume;

        if (currentStep >= steps) {
          clearInterval(fadeTimerRef.current);
          fadeTimerRef.current = null;
        }
      }, stepMs);
    }

    transitionTimerRef.current = setTimeout(() => {
      playTrack(nextTrack);
    }, fadeMs > 0 ? fadeMs : 0);
  }

  function scheduleTransition() {
    clearTimers();

    if (!playing || !currentTrack || !nextTrack) return;

    const delayMs = Math.max(1, Number(mixInterval) || 1) * 1000;

    transitionTimerRef.current = setTimeout(() => {
      startFadeAndTransition();
    }, delayMs);
  }

  function playTrack(track) {
    if (!track || !audioRef.current) return;

    clearTimers();

    const audio = audioRef.current;
    setCurrentTrack(track);
    setPlaying(true);

    audio.volume = 1;
    audio.src = `/tracks/${track.id}/stream`;
    audio
      .play()
      .then(() => {
        refreshNext(track.id);
      })
      .catch(() => {
        alert("Nie udało się odtworzyć pliku.");
      });
  }

  function stopPlayback() {
    clearTimers();
    setPlaying(false);

    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audio.volume = 1;
    }
  }

  async function handleEnded() {
    clearTimers();

    if (nextTrack) {
      playTrack(nextTrack);
    } else {
      setPlaying(false);
    }
  }

  useEffect(() => {
    refreshTracks(false).catch((e) => alert(e.message));
  }, []);

  useEffect(() => {
    refreshTracks(showTrash).catch((e) => alert(e.message));
    setSelectedIds([]);
  }, [showTrash]);

  useEffect(() => {
    if (!currentTrack) {
      refreshNext(null);
    } else {
      refreshNext(currentTrack.id);
    }
  }, [currentTrack, tracks]);

  useEffect(() => {
    scheduleTransition();
    return clearTimers;
  }, [playing, currentTrack, nextTrack, mixInterval, fadeSeconds]);

  async function handleUpload(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    setUploading(true);

    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch(`/tracks/upload`, {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          let msg = "Upload failed";
          try {
            const err = await res.json();
            msg = err.detail || msg;
          } catch {}
          throw new Error(msg);
        }
      }

      await refreshTracks(showTrash);
      event.target.value = "";
    } catch (e) {
      alert(`Upload error: ${e.message}`);
    } finally {
      setUploading(false);
    }
  }

  function isSelected(id) {
    return selectedIds.includes(id);
  }

  function toggleSelected(id) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function selectAllVisible() {
    setSelectedIds(tracks.map((t) => t.id));
  }

  function clearSelection() {
    setSelectedIds([]);
  }

  async function moveToTrash() {
    if (!selectedIds.length) return;

    try {
      await Promise.all(
        selectedIds.map((id) =>
          fetch(`/tracks/${id}`, {
            method: "DELETE",
          })
        )
      );
      setSelectedIds([]);
      await refreshTracks(showTrash);
    } catch {
      alert("Nie udało się przenieść do kosza.");
    }
  }

  async function restoreSelected() {
    if (!selectedIds.length) return;

    try {
      const res = await fetch(`/tracks/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectedIds),
      });

      if (!res.ok) {
        throw new Error("Restore failed");
      }

      setSelectedIds([]);
      await refreshTracks(showTrash);
    } catch {
      alert("Nie udało się przywrócić plików.");
    }
  }

  async function purgeSelected() {
    if (!selectedIds.length) return;
    if (!window.confirm("Na pewno usunąć wybrane pliki bezpowrotnie?")) return;

    try {
      const res = await fetch(`/tracks/purge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectedIds),
      });

      if (!res.ok) {
        throw new Error("Purge failed");
      }

      setSelectedIds([]);
      await refreshTracks(showTrash);
    } catch {
      alert("Nie udało się usunąć plików.");
    }
  }

  async function purgeTrash() {
    if (!window.confirm("Na pewno opróżnić cały kosz?")) return;

    try {
      const res = await fetch(`/tracks/purge-trash`, {
        method: "POST",
      });

      if (!res.ok) {
        throw new Error("Purge trash failed");
      }

      setSelectedIds([]);
      await refreshTracks(showTrash);
    } catch {
      alert("Nie udało się opróżnić kosza.");
    }
  }

  const visibleTracks = tracks.filter((t) => (showTrash ? true : !t.deleted));

  return (
    <div className="app">
      <h1>Auto-DJ Light — MP3/WAV</h1>

      <div className="topbar">
        <input
          type="file"
          accept=".mp3,.wav,audio/mpeg,audio/wav"
          multiple
          onChange={handleUpload}
          disabled={uploading}
        />

        <button
          onClick={() => {
            if (playing) {
              stopPlayback();
            } else if (currentTrack) {
              playTrack(currentTrack);
            } else if (visibleTracks.length) {
              playTrack(visibleTracks[visibleTracks.length - 1]);
            }
          }}
          disabled={!visibleTracks.length}
        >
          {playing ? "STOP" : "START"}
        </button>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={showTrash}
            onChange={(e) => setShowTrash(e.target.checked)}
          />
          Pokaż kosz
        </label>
      </div>

      <div className="now-grid">
        <div className="card">
          <h2>Now playing</h2>
          {currentTrack ? (
            <div>
              <div className="track-title">{currentTrack.original_name}</div>
              <div className="muted">ID: {currentTrack.id}</div>
            </div>
          ) : (
            <div className="muted">—</div>
          )}
        </div>

        <div className="card">
          <h2>Next up</h2>
          {nextTrack ? (
            <div>
              <div className="track-title">{nextTrack.original_name}</div>
              <div className="muted">ID: {nextTrack.id}</div>
            </div>
          ) : (
            <div className="muted">—</div>
          )}
        </div>
      </div>

      <div className="sliders">
        <div className="slider-box">
          <label>Mix interval (s): {mixInterval}</label>
          <input
            type="range"
            min="5"
            max="300"
            value={mixInterval}
            onChange={(e) => setMixInterval(Number(e.target.value))}
          />
        </div>

        <div className="slider-box">
          <label>Fade (s): {fadeSeconds}</label>
          <input
            type="range"
            min="0"
            max="30"
            value={fadeSeconds}
            onChange={(e) => setFadeSeconds(Number(e.target.value))}
          />
        </div>
      </div>

      <audio ref={audioRef} onEnded={handleEnded} controls className="player" />

      <div className="toolbar">
        <div>
          Widoczne: {visibleTracks.length} | zaznaczone: {selectedIds.length}
        </div>

        <div className="toolbar-buttons">
          <button onClick={selectAllVisible} disabled={!visibleTracks.length}>
            Zaznacz wszystko
          </button>

          <button onClick={clearSelection} disabled={!selectedIds.length}>
            Wyczyść zaznaczenie
          </button>

          {!showTrash ? (
            <button onClick={moveToTrash} disabled={!selectedIds.length}>
              Do kosza
            </button>
          ) : (
            <>
              <button onClick={restoreSelected} disabled={!selectedIds.length}>
                Przywróć
              </button>
              <button onClick={purgeSelected} disabled={!selectedIds.length}>
                Usuń na stałe
              </button>
              <button onClick={purgeTrash} disabled={!visibleTracks.length}>
                Opróżnij kosz
              </button>
            </>
          )}
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Name</th>
              <th>Status</th>
              <th>Akcja</th>
            </tr>
          </thead>
          <tbody>
            {visibleTracks.map((track) => (
              <tr key={track.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={isSelected(track.id)}
                    onChange={() => toggleSelected(track.id)}
                  />
                </td>
                <td>{track.original_name}</td>
                <td>{track.deleted ? "Kosz" : "OK"}</td>
                <td>
                  {!track.deleted && (
                    <button onClick={() => playTrack(track)}>Play</button>
                  )}
                </td>
              </tr>
            ))}

            {!visibleTracks.length && (
              <tr>
                <td colSpan="4" className="empty">
                  Brak plików
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default App;