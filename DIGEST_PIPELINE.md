# Digest Generation Pipeline

End-to-end overview of how FeedFactory ingests articles, clusters them, generates AI narratives, and syncs the result to the AI Digest feed.

---

## Trigger

The pipeline starts at `generate_digest_for_collection()` (`main.py:705`), called either via `POST /api/collections/{id}/trigger` or by `scheduled_checker()` which runs every 15 minutes via APScheduler. The collection's `is_generating` flag is set to `True` immediately and cleared in a `finally` block on exit.

---

## Step 1 — Parallel Feed Fetch (`main.py:725`)

`ThreadPoolExecutor(max_workers=15)` calls `fetch_external_feed()` for every `Feed` in the collection simultaneously. Supports conditional HTTP requests (ETag / Last-Modified → 304 Not Modified handling). Updated tokens are persisted back to the `Feed` row in the DB.

---

## Step 2 — Per-Entry Filtering (`main.py:750`)

For each entry from each feed, three filters run in sequence:

1. **Age filter** — drops entries older than the collection's `filter_age` window (`24h`, `new` since last run, or `all`)
2. **Auto-scrape** — if `feed.auto_scrape` is set, fetches the full article body via the Mercury Parser sidecar. Cache-first: checks `CachedArticle.scraped_content` before hitting Mercury. Falls back to the RSS `summary` on failure.
3. **Focus keyword filter** — if `collection.focus_keywords` is set, drops any entry where none of the keywords appear in `title + text`

Each surviving entry is HTML-stripped (BeautifulSoup), truncated to `collection.context_length`, and normalized into a dict: `{title, link, text, timestamp, formatted}`.

---

## Step 3 — Entry Cap (`main.py:835`)

Entries are sorted newest-first, then capped at `collection.filter_max_articles` (if set). There is no hard cap; unconstrained collections pass all filtered entries to the clustering step.

---

## Step 4 — Semantic Embedding + HDBSCAN Clustering (`main.py:841`, `cluster_articles()` at `main.py:2183`)

1. Every entry's `title + text` is fed to `embed_texts()` (`all-MiniLM-L6-v2` or a configured embedding API), producing a float32 embedding per article.
2. Embeddings are L2-normalized (making Euclidean distance equivalent to cosine distance for MiniLM vectors).
3. HDBSCAN runs with collection-tunable parameters (`min_cluster_size`, `min_samples`, `cluster_selection_epsilon`, `cluster_selection_method`). Noise points (label `-1`) are silently discarded.
4. Returns a list of `(cluster_articles, center_embedding)` tuples, plus the full embedding matrix. If HDBSCAN finds no clusters, all articles are returned as a single group.

---

## Step 5 — Cluster Entity Profiling (`main.py:858`)

For each cluster, the article `link` values are looked up in `CachedArticle` to get DB IDs, then `profile_cluster()` extracts named entities via NLP. This entity list guides RAG retrieval in the next step.

---

## Step 6 — Per-Cluster LLM Calls, Parallel (`main.py:957`, `process_cluster()` at `main.py:881`)

`ThreadPoolExecutor(max_workers=5)` runs `process_cluster()` for each cluster simultaneously. Each call:

1. **RAG retrieval** — `retrieve_historical_context()` (`main.py:1172`) performs a cosine vector search against either:
   - `vec_articles` / `ArticleVector` — past digest source articles for this collection (`search_space="digest"`)
   - `vec_cached_articles` / `ArticleEmbedding` — subscription feed articles (`search_space="feed"`) with entity pre-filter JOIN

   Only results older than the current collection window and above `rag_min_similarity` are returned. Retrieved vector rows have their `last_retrieved_at` and `retrieval_count` updated.

2. **Title LLM call** — sends cluster article titles to `TITLE_SYSTEM_PROMPT` → short headline string.

3. **Narrative LLM call** — sends full formatted article text + historical RAG context (wrapped in `<historical_context>` tags) to the collection's `system_prompt` → prose narrative paragraph(s). Legacy prompts are silently replaced with the current default.

4. **Programmatic HTML assembly** — the narrative paragraphs, a Sources `<ul>` (linked article titles), and a Context `<ul>` (RAG links) are concatenated into `body_html`.

Returns `(topic_title, body_html)` per cluster.

---

## Step 7 — Vector Storage (`main.py:964`, `_store_article_vectors()` at `main.py:1132`)

Deliberately runs **after** LLM retrieval to prevent current-run articles from polluting the RAG search space. Upserts article embeddings into both `ArticleVector` (ORM table) and `vec_articles` (sqlite-vec virtual table).

---

## Step 8 — RSS File Write (`main.py:967`, `save_rss_file()` at `main.py:670`)

Assembles a standard RSS 2.0 XML file with one `<item>` per cluster: title, `body_html` in `<description><![CDATA[...]]>`, and a timestamp-based unique GUID (`{slug}-{unix_ts}-{index}`). Written to `/app/data/feeds/{collection.slug}.xml`. `collection.last_run` is then updated in the DB.

---

## Step 9 — Feed Sync to AI Digest Feed (`main.py:973`, `sync_all_feeds()` at `main.py:453`)

A background thread immediately runs `sync_all_feeds()`, which:

1. Looks up the **"AI Digest"** category in the DB and backfills any generated articles missing a `category_id`.
2. For each collection, `feedparser` reads the XML file from disk. Any entry whose `link` doesn't already exist in `CachedArticle` is inserted as a new row with:
   - `is_generated = True`
   - `feed_id = "col_{collection.id}"`
   - `source_title = "✨ {collection.name}"`
   - `category_id` pointing to the AI Digest category
3. Subscription (reader) feeds are also re-synced in parallel during the same job.
4. Post-commit, `process_article_nlp_batch()` runs NLP entity tagging on all newly inserted articles.
5. Orphaned articles with a missing `category_id` are reconciled to their feed's category.

After this sync completes, the digest articles are visible in the reader under the AI Digest category.
