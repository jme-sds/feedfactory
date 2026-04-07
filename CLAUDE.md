# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

FeedFactory is a hybrid RSS feed aggregator and AI-powered news digest generator. It fetches RSS feeds, clusters articles semantically using embeddings + K-means, and synthesizes per-topic summaries via an OpenAI-compatible LLM API. Digests are republished as RSS feeds for downstream consumption.

## Commands

### Backend (FastAPI)
```bash
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend (Next.js)
```bash
cd frontend
npm install
npm run dev       # dev server on port 3000 (proxies /api/* → localhost:8000)
npm run build     # production build
npm run lint      # ESLint
```

### Docker (primary deployment method)
```bash
docker compose up          # Run all services
docker compose build       # Rebuild image
docker compose up -d       # Run detached
```

### CI/CD
Push to `main` triggers `.github/workflows/build-and-push.yml`, which builds multi-arch images (amd64/arm64) and pushes to `ghcr.io/jme-sds/feedfactory`.

## Architecture

### Key Files
- **`main.py`** — Entire FastAPI application: routes, background jobs, LLM integration, feed processing, clustering logic. SQLModel ORM models (`GlobalSettings`, `Category`, `Collection`, `Feed`, `Subscription`, `ReadItem`, `CachedArticle`) are defined inline here, not in a separate file.
- **`frontend/`** — Next.js 15 / React 19 frontend. Key files:
  - `src/lib/api.ts` — Typed API client; all backend calls go through `apiFetch()` which handles CSRF tokens and auth redirects
  - `src/lib/store.ts` — Zustand store for reader navigation state (selected category/feed/article, mobile view)
  - `src/app/` — Next.js App Router pages (`/`, `/login`, `/settings`, `/collections`)
  - `src/components/` — UI components split into `layout/`, `reader/`, `collections/`, `ui/`
  - `next.config.ts` — Rewrites `/api/*`, `/feeds/*`, `/status.json`, and a few other paths to `BACKEND_URL` (default: `http://feedfactory:8000`)

### Services (compose.yml)
- `feedfactory` — FastAPI backend (port 8000, internal only)
- `frontend` — Next.js app (port 3001 → container 3000); proxies all `/api/*` to backend
- `parser` — Mercury Parser API sidecar (`wangqiru/mercury-parser-api`) on port 3000 for full-text extraction

### Database
SQLite at `/app/data/database.db`. Schema migrates automatically on startup via `upgrade_db_schema()` which adds missing columns to existing tables — no Alembic/migration files.

### Digest Generation Pipeline (the core feature)
Triggered manually via `POST /api/collections/{id}/trigger` or on schedule:
1. Fetch RSS feeds in the collection (parallel)
2. Optionally extract full text via Mercury Parser (`auto_scrape` flag on Feed)
3. Filter by age, focus keywords, and context length
4. Embed articles with `all-MiniLM-L6-v2` (sentence-transformers) + `sqlite-vec` for vector storage
5. K-means cluster into N topics, remove outliers by distance threshold
6. Call LLM in parallel per cluster to generate narrative paragraphs
7. Assemble HTML digest, save as XML to `data/` directory
8. Persist to `CachedArticle` table

### Background Jobs (APScheduler)
- Every 15 min: `sync_all_feeds()` — refreshes CachedArticle table from XML files
- Every 15 min: `scheduled_checker()` — runs digest generation for collections whose scheduled time has passed
- Every 1 hr: `cleanup_old_articles()` — enforces retention policies from GlobalSettings

### LLM Integration
Supports any OpenAI-compatible endpoint (OpenAI, LiteLLM proxy, Hugging Face). Configured via `GlobalSettings` (stored in DB) or `.env` (`OPENAI_API_KEY`, `OPENAI_BASE_URL`). Default model: Qwen/Qwen2.5-72B-Instruct.

### Feed Reader (secondary feature)
Classic RSS reader: `Subscription` model tracks feeds per-user, `Category` for organization, `ReadItem` for read state. Articles served from `CachedArticle` table (synced every 15 min). OPML import/export supported. TanStack Query manages server state on the frontend; Zustand handles UI navigation state.

## Environment Variables
- `OPENAI_API_KEY` — LLM authentication
- `OPENAI_BASE_URL` — LLM endpoint
- `BACKEND_URL` — (frontend only) URL of the FastAPI backend, default `http://feedfactory:8000`
- `DEMO_MODE` — Enable demo mode with preset credentials
- `HF_TOKEN` — Hugging Face token fallback
- `TZ` — Timezone
