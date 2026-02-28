FROM python:3.12-slim

# --- system deps (jeśli używasz ffmpeg / librosa)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- deps python
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# --- app code
COPY app ./app

# --- PRO: non-root user (UID/GID 1000)
ARG UID=1000
ARG GID=1000
RUN groupadd -g ${GID} appgroup \
 && useradd -m -u ${UID} -g ${GID} appuser

# katalog na dane (baza + audio) + prawa
RUN mkdir -p /app/data /app/data/audio \
 && chown -R ${UID}:${GID} /app

USER appuser

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]