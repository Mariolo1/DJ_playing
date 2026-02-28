# Auto-DJ (Docker) — Ubuntu / Linux

## Start
W katalogu projektu:

```bash
docker compose up --build
```

- Frontend: http://localhost:3000
- Backend: http://localhost:8000/docs

## Dane
Pliki audio + SQLite są w `./data/` (volume do kontenera backendu).

## Zmiany uwzględnione
- Upload zapisuje pliki jako UUID (brak `.mp3.mp3` i problemów z polskimi znakami).
- Analiza MP3 działa przez `ffmpeg -> wav` (stabilne).
- Mix interval działa w trakcie grania (restart timera).
- Energy target odświeża „Next up” natychmiast.
# DJ_playing
