# FeedFactory

FeedFactory is a hybrid RSS feed reader and AI-powered news digest generator. It subscribes to RSS feeds, clusters articles semantically using embeddings and K-means/HDBSCAN, and synthesizes per-topic summaries via any OpenAI-compatible LLM. Digests are republished as RSS feeds for downstream consumption.

---

## Features

### Feed Reader
- Subscribe to RSS feeds organized into categories
- Full-text extraction via Mercury Parser sidecar (optional, per-feed toggle)
- Read/unread tracking with bulk mark-all-read
- Favorite articles for later reference
- OPML import and export
- Article search and filtering by age, keyword, and topic
- Named entity extraction (people, organizations, places) for browsable entity index
- ML-based topic tagging with user feedback training
- Progressive Web App (PWA) with offline article cache

### AI Digest Generation
- Group feeds into **Collections** and generate AI-written digests on demand or on a schedule
- Articles are embedded with `all-MiniLM-L6-v2` and clustered by topic (HDBSCAN or K-means)
- Each cluster is summarized into a narrative paragraph via your configured LLM
- Supports focus keywords to bias clustering toward topics of interest
- Digests are published as RSS feeds (`/feeds/<slug>.xml`) consumable by any reader
- Per-collection configuration: schedule, context length, article age filter, max articles, clustering parameters
- Configurable system prompt per collection

### Settings & Customization
- Connect any OpenAI-compatible LLM (OpenAI, LiteLLM, Hugging Face Inference, etc.)
- Reader font family, size, and line-height (separate desktop and mobile settings)
- Light/dark theme with accent color
- Article retention policies (read and unread)
- Full settings backup and restore

---

## Tech Stack

- **Backend**: FastAPI, SQLite (via SQLModel + sqlite-vec), APScheduler
- **ML/NLP**: sentence-transformers, HDBSCAN, scikit-learn, spaCy
- **Frontend**: Next.js 15, React 19, TanStack Query, Zustand, Tailwind CSS
- **Deployment**: Docker Compose, GitHub Actions (multi-arch builds)

---

## Quick Start

### Prerequisites
- Docker and Docker Compose

### 1. Clone the repository

```bash
git clone https://github.com/jme-sds/feedfactory.git
cd feedfactory
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set at minimum `OPENAI_API_KEY` (and `OPENAI_BASE_URL` if not using OpenAI directly).

### 3. Start the services

```bash
docker compose up -d
```

The app will be available at **http://localhost:3001**.

### 4. (Optional) Use a pre-built image

The `compose.yml` can be pointed at the published image instead of building locally:

```yaml
image: ghcr.io/jme-sds/feedfactory:latest
```

---

## Environment Variables

### Backend

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | **Yes** | — | API key for your LLM provider |
| `OPENAI_BASE_URL` | No | `https://router.huggingface.co/v1/chat/completions` | Base URL for any OpenAI-compatible endpoint |
| `DEMO_MODE` | No | `false` | Enable demo mode with a preset read-only account |
| `DEMO_USER` | No | `demo` | Username for the demo account (only used when `DEMO_MODE=true`) |
| `DEMO_PASS` | No | `demo` | Password for the demo account (only used when `DEMO_MODE=true`) |
| `HF_TOKEN` | No | — | Hugging Face token used as a fallback for downloading embedding models |
| `TZ` | No | `America/New_York` | Timezone used for digest scheduling |

### Frontend

| Variable | Required | Default | Description |
|---|---|---|---|
| `BACKEND_URL` | No | `http://feedfactory:8000` | Internal URL of the FastAPI backend, used by the Next.js container for server-side proxying |

> Most settings (LLM model, default schedule, retention policies, clustering parameters, reader styling) are configured through the in-app **Settings** page and stored in the database — no environment variables needed.

---

## Ports

| Service | Host Port | Notes |
|---|---|---|
| Frontend (Next.js) | **3001** | Main entry point — open this in your browser |
| Backend (FastAPI) | — | Internal only, not exposed to the host |
| Mercury Parser | — | Internal only, not exposed to the host |

---

## Development Setup

### Backend

```bash
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev   # starts on localhost:3000, proxies /api/* → localhost:8000
```

---

## CI/CD

Pushing to `main` triggers `.github/workflows/build-and-push.yml`, which builds multi-architecture images (amd64 and arm64) and pushes them to `ghcr.io/jme-sds/feedfactory`.
