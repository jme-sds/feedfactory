from fastapi import FastAPI, Request, Form, Depends, HTTPException, UploadFile, File, BackgroundTasks
from fastapi.responses import HTMLResponse, Response, StreamingResponse, FileResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, SQLModel, create_engine, select, or_, and_, Field, Relationship
from sqlalchemy import inspect, text
from apscheduler.schedulers.background import BackgroundScheduler
from contextlib import asynccontextmanager
from typing import Optional, List
from urllib.parse import urljoin
from bs4 import BeautifulSoup
import feedparser
import datetime
import time
import os
import shutil
import logging
import xml.etree.ElementTree as ET
import io
import requests
import re
import concurrent.futures
import threading
import html
import json
import hmac
import secrets
import hashlib
import socket
import ipaddress
from sentence_transformers import SentenceTransformer
from sklearn.cluster import KMeans
import numpy as np
import array
import sqlite_vec
from sqlalchemy import event
import gc
from textblob import TextBlob
import spacy
import hdbscan



logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("FeedFactory")

DB_FILE = "/app/data/database.db"
DATABASE_URL = f"sqlite:///{DB_FILE}"

# --- UPDATE YOUR INITIAL PROMPT CONSTANT ---
INITIAL_SYSTEM_PROMPT = """You are an expert news editor. You have been given a list of highly related articles about a specific topic.
Your goal is to write a single cohesive narrative paragraph for this topic.

Write a HIGH-LEVEL NARRATIVE PARAGRAPH (4-6 sentences) that synthesizes the news. Explain "what is going on" by weaving the facts together.

Output only the paragraph text. Do NOT include a title, headings, HTML tags, bullet points, or source lists."""

TITLE_SYSTEM_PROMPT = """You are a news editor. Given a list of article titles about a single topic cluster, produce a short, punchy headline (5–10 words) that captures the shared theme.

Output only the headline text — no quotes, no punctuation at the end, no HTML, no explanation."""


engine = create_engine(DATABASE_URL)

@event.listens_for(engine, "connect")
def load_sqlite_vec(dbapi_conn, connection_record):
    dbapi_conn.enable_load_extension(True)
    sqlite_vec.load(dbapi_conn)
    dbapi_conn.enable_load_extension(False)

# --- Batch scrape tracking ---
_active_batch_scrapes: set = set()
_batch_scrape_lock = threading.Lock()

# --- Polite fetching state ---
# Per-domain semaphore: limit concurrent RSS requests to 2 per origin.
_domain_semaphores: dict = {}
_domain_semaphores_lock = threading.Lock()

# Per-feed backoff: url -> float (unix timestamp until which the feed is suppressed)
_feed_backoff: dict = {}

# Per-URL on-demand scrape cooldown: url -> float (last scrape timestamp)
_scrape_last_fetched: dict = {}

FEEDFACTORY_UA = "FeedFactory/1.0 (+https://github.com/jme-sds/feedfactory; feed-reader)"

def _get_domain_semaphore(url: str) -> threading.Semaphore:
    """Return (creating if needed) a per-domain semaphore capped at 2 concurrent requests."""
    try:
        from urllib.parse import urlparse as _urlparse
        netloc = _urlparse(url).netloc or url
    except Exception:
        netloc = url
    with _domain_semaphores_lock:
        if netloc not in _domain_semaphores:
            _domain_semaphores[netloc] = threading.Semaphore(2)
        return _domain_semaphores[netloc]

# --- Models ---
class GlobalSettings(SQLModel, table=True):
    id: int = Field(default=1, primary_key=True)
    api_type: str = Field(default="openai") 
    api_endpoint: str = Field(default="https://router.huggingface.co/v1/chat/completions") 
    api_key: Optional[str] = None 
    model_name: str = Field(default="Qwen/Qwen2.5-72B-Instruct") 
    default_schedule: str = Field(default="06:00")
    default_context_length: int = Field(default=200)
    default_filter_max: int = Field(default=0)
    default_filter_age: str = Field(default="24h")
    default_system_prompt: str = Field(default="You are an expert news editor...")
    retention_read_days: int = Field(default=3)
    retention_unread_days: int = Field(default=14)
    reader_font_family: str = Field(default="system-ui, -apple-system, sans-serif")
    reader_font_size: str = Field(default="1.15rem")
    reader_line_height: str = Field(default="1.7")
    reader_font_family_mobile: str = Field(default="")
    reader_font_size_mobile: str = Field(default="")
    reader_line_height_mobile: str = Field(default="")
    # --- NEW: PWA Offline Limit ---
    pwa_offline_limit: int = Field(default=200)
    default_focus_keywords: str = Field(default="")
    ui_theme: str = Field(default="default")
    ui_accent: str = Field(default="")
    ui_custom_colors: str = Field(default="")
    default_hdbscan_min_cluster_size: int = Field(default=3)
    default_hdbscan_min_samples: int = Field(default=0)  # 0 = use min_cluster_size (HDBSCAN default)
    default_hdbscan_cluster_selection_epsilon: float = Field(default=0.0)
    default_hdbscan_cluster_selection_method: str = Field(default="eom")

class Category(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True)

class Collection(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    slug: str = Field(unique=True, index=True)
    schedule_time: str = Field(default="06:00")
    last_run: Optional[datetime.datetime] = None
    is_generating: bool = Field(default=False)
    system_prompt: Optional[str] = Field(default=None)
    context_length: int = Field(default=200)
    filter_max_articles: int = Field(default=0)
    filter_age: str = Field(default="24h")
    category_id: Optional[int] = Field(default=None, foreign_key="category.id")
    feeds: List["Feed"] = Relationship(back_populates="collection")
    focus_keywords: str = Field(default="")
    max_articles_per_topic: int = Field(default=4)
    is_active: bool = Field(default=True)
    rag_top_k: int = Field(default=3)
    rag_min_similarity: float = Field(default=0.60)
    rag_eviction_days: int = Field(default=14)
    hdbscan_min_cluster_size: int = Field(default=3)
    hdbscan_min_samples: int = Field(default=0)  # 0 = use min_cluster_size (HDBSCAN default)
    hdbscan_cluster_selection_epsilon: float = Field(default=0.0)
    hdbscan_cluster_selection_method: str = Field(default="eom")

class ArticleVector(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    collection_id: int = Field(foreign_key="collection.id", index=True)
    title: str
    content: str
    url: str = Field(index=True)
    embedding: bytes
    last_retrieved_at: datetime.datetime = Field(default_factory=datetime.datetime.now)
    retrieval_count: int = Field(default=0)
    ingested_at: datetime.datetime = Field(default_factory=datetime.datetime.now, index=True)

class Feed(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    url: str
    collection_id: Optional[int] = Field(default=None, foreign_key="collection.id")
    collection: Optional[Collection] = Relationship(back_populates="feeds")
    auto_scrape: bool = Field(default=False)
    etag: Optional[str] = Field(default=None)
    last_modified: Optional[str] = Field(default=None)

class Subscription(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    url: str = Field(unique=True)
    title: Optional[str] = None
    category_id: Optional[int] = Field(default=None, foreign_key="category.id")
    added_at: datetime.datetime = Field(default_factory=datetime.datetime.now)
    auto_scrape: bool = Field(default=False)
    etag: Optional[str] = Field(default=None)
    last_modified: Optional[str] = Field(default=None)

class ReadItem(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    item_link: str = Field(unique=True, index=True)
    read_at: datetime.datetime = Field(default_factory=datetime.datetime.now)

class FavoriteItem(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    item_link: str = Field(unique=True, index=True)
    favorited_at: datetime.datetime = Field(default_factory=datetime.datetime.now)
    unfavorited_at: Optional[datetime.datetime] = Field(default=None)

class CachedArticle(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    ui_id: str = Field(index=True)
    feed_id: str = Field(default="", index=True)
    link: str = Field(unique=True, index=True)
    title: str
    display_body: str
    published: float = Field(index=True)
    source_title: str
    source_color: str
    is_generated: bool
    category_id: Optional[int] = Field(default=None, foreign_key="category.id")
    added_at: datetime.datetime = Field(default_factory=datetime.datetime.now)
    scraped_content: Optional[str] = Field(default=None)
    subjectivity_score: Optional[float] = Field(default=None)
    heuristic_tag: Optional[str] = Field(default=None)


class ArticleEmbedding(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    article_id: int = Field(foreign_key="cachedarticle.id", index=True)
    embedding: bytes
    created_at: datetime.datetime = Field(default_factory=datetime.datetime.now)


class ArticleEntity(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    article_id: int = Field(foreign_key="cachedarticle.id", index=True)
    entity_text: str
    entity_label: str  # PERSON / ORG / GPE


# --- Helpers ---
def clean_model_id(raw_id: str) -> str:
    if not raw_id: return ""
    return str(raw_id).replace('\\"', '').strip(' "\'')

def _sanitize_css_value(val: str) -> str:
    """Strip characters that could break out of a CSS property value context."""
    if not val:
        return val
    # Remove anything that could close a style block or inject HTML/JS
    return re.sub(r'[<>{};\\]', '', val)

def _sanitize_slug(slug: str) -> str:
    """Ensure a slug is safe for use in filesystem paths — alphanumeric, hyphens, underscores only."""
    return re.sub(r'[^a-zA-Z0-9_-]', '', slug)

def get_settings(session: Session) -> GlobalSettings:
    settings = session.get(GlobalSettings, 1)
    if not settings:
        settings = GlobalSettings(
            id=1, api_key=os.getenv("HF_TOKEN"), api_endpoint="https://router.huggingface.co/v1/chat/completions",
            model_name="Qwen/Qwen2.5-72B-Instruct", default_system_prompt=INITIAL_SYSTEM_PROMPT
        )
        session.add(settings); session.commit(); session.refresh(settings)
    return settings

_FEED_NOT_MODIFIED = object()  # sentinel for 304 responses

def fetch_external_feed(url, etag=None, last_modified=None):
    """Fetch an RSS feed with conditional request support and polite error handling.

    Returns:
        feedparser result on success
        _FEED_NOT_MODIFIED sentinel on 304 Not Modified
        None on failure
    """
    # Skip feeds that are in backoff after a 429/503
    backoff_until = _feed_backoff.get(url)
    if backoff_until and time.time() < backoff_until:
        logger.info(f"[Feed] Skipping {url} — in backoff until {datetime.datetime.fromtimestamp(backoff_until).isoformat()}")
        return None

    headers = {"User-Agent": FEEDFACTORY_UA}
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified

    sem = _get_domain_semaphore(url)
    for attempt in range(2):
        try:
            with sem:
                resp = requests.get(url, headers=headers, timeout=12)

            if resp.status_code == 304:
                return _FEED_NOT_MODIFIED

            if resp.status_code == 429 or resp.status_code == 503:
                retry_after = resp.headers.get("Retry-After")
                delay = 60.0
                if retry_after:
                    try:
                        delay = float(retry_after)
                    except ValueError:
                        pass
                _feed_backoff[url] = time.time() + delay
                logger.warning(f"[Feed] {resp.status_code} from {url} — backing off for {delay:.0f}s")
                return None

            if resp.status_code != 200:
                logger.warning(f"[Feed] HTTP {resp.status_code} from {url}")
                return None

            parsed = feedparser.parse(resp.content)
            # Attach conditional-request values for the caller to persist
            parsed._ff_etag = resp.headers.get("ETag")
            parsed._ff_last_modified = resp.headers.get("Last-Modified")
            return parsed

        except requests.exceptions.Timeout:
            if attempt == 0:
                logger.warning(f"[Feed] Timeout fetching {url}, retrying...")
                time.sleep(3)
            else:
                logger.warning(f"[Feed] Timeout on retry for {url}, giving up.")
        except requests.exceptions.RequestException as e:
            logger.warning(f"[Feed] Request error for {url}: {e}")
            break

    return None

def parse_date(entry):
    if hasattr(entry, 'published_parsed') and entry.published_parsed: return time.mktime(entry.published_parsed)
    if hasattr(entry, 'updated_parsed') and entry.updated_parsed: return time.mktime(entry.updated_parsed)
    return time.time()

# --- BACKGROUND SYNC AND CLEANUP ---
def sync_all_feeds():
    logger.info("Starting background feed sync...")
    newly_inserted_links: List[str] = []
    with Session(engine) as session:
        collections = session.exec(select(Collection)).all()
        for col in collections:
            path = f"/app/data/feeds/{col.slug}.xml"
            if os.path.exists(path):
                try:
                    feed = feedparser.parse(path)
                    for entry in feed.entries:
                        if not session.exec(select(CachedArticle).where(CachedArticle.link == entry.link)).first():
                            body = entry.content[0].value if 'content' in entry and entry.content else entry.get('summary', '') or entry.get('description', '')
                            session.add(CachedArticle(
                                ui_id=str(hash(entry.link)), feed_id=f"col_{col.id}", link=entry.link, title=entry.title, display_body=body,
                                published=parse_date(entry), source_title=f"✨ {col.name}", source_color="#1095c1",
                                is_generated=True, category_id=col.category_id
                            ))
                            newly_inserted_links.append(entry.link)
                except Exception as e: logger.error(f"Sync error (Collection {col.name}): {e}")

        subs = session.exec(select(Subscription)).all()
        links_to_scrape = []  # (link, sub_id) for auto_scrape subs
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            future_to_sub = {
                executor.submit(fetch_external_feed, sub.url, sub.etag, sub.last_modified): sub
                for sub in subs
            }
            for future in concurrent.futures.as_completed(future_to_sub):
                sub = future_to_sub[future]
                try:
                    feed = future.result()
                    if feed is _FEED_NOT_MODIFIED:
                        logger.info(f"[Sync] {sub.url} — not modified (304), skipping.")
                        continue
                    if feed:
                        # Persist updated conditional-request tokens
                        if getattr(feed, '_ff_etag', None) or getattr(feed, '_ff_last_modified', None):
                            db_sub = session.get(Subscription, sub.id)
                            if db_sub:
                                if feed._ff_etag:
                                    db_sub.etag = feed._ff_etag
                                if feed._ff_last_modified:
                                    db_sub.last_modified = feed._ff_last_modified
                                session.add(db_sub)
                        title = sub.title or feed.feed.get('title', 'Unknown Feed')
                        for entry in feed.entries:
                            if not session.exec(select(CachedArticle).where(CachedArticle.link == entry.link)).first():
                                body = entry.content[0].value if 'content' in entry and entry.content else entry.get('summary', '') or entry.get('description', '')
                                session.add(CachedArticle(
                                    ui_id=str(hash(entry.link)), feed_id=f"sub_{sub.id}", link=entry.link, title=entry.title, display_body=body,
                                    published=parse_date(entry), source_title=title, source_color="#4CAF50",
                                    is_generated=False, category_id=sub.category_id
                                ))
                                newly_inserted_links.append(entry.link)
                                if sub.auto_scrape and entry.link:
                                    links_to_scrape.append(entry.link)
                except Exception as e: logger.error(f"Sync error (Sub {sub.url}): {e}")
        session.commit()

        # Auto-scrape new articles for subscriptions with auto_scrape enabled
        if links_to_scrape:
            logger.info(f"[Auto-Scrape] Scraping {len(links_to_scrape)} new articles in background...")
            def _scrape_and_cache(link):
                try:
                    html = scrape_article_html(link)
                    with Session(engine) as s:
                        art = s.exec(select(CachedArticle).where(CachedArticle.link == link)).first()
                        if art and not art.scraped_content:
                            art.scraped_content = html
                            s.add(art)
                            s.commit()
                except Exception as e:
                    logger.warning(f"[Auto-Scrape] Failed {link}: {e}")
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as scrape_pool:
                scrape_pool.map(_scrape_and_cache, links_to_scrape)

    # NLP processing for newly ingested articles (fresh session after commit)
    if newly_inserted_links:
        try:
            with Session(engine) as nlp_session:
                new_articles = nlp_session.exec(
                    select(CachedArticle).where(CachedArticle.link.in_(newly_inserted_links))
                ).all()
                process_article_nlp_batch(new_articles, nlp_session)
        except Exception as e:
            logger.error(f"[NLP] Post-sync NLP batch failed: {e}")

    logger.info("Feed sync complete.")

def cleanup_old_articles():
    logger.info("Running article cleanup...")
    with Session(engine) as session:
        settings = get_settings(session)
        now = time.time()
        read_cutoff = now - (settings.retention_read_days * 86400)
        unread_cutoff = now - (settings.retention_unread_days * 86400)
        articles = session.exec(select(CachedArticle)).all()
        read_links = {r.item_link for r in session.exec(select(ReadItem)).all()}
        fav_items = {f.item_link: f for f in session.exec(select(FavoriteItem)).all()}
        deleted = 0
        for article in articles:
            link = article.link
            # Currently favorited: never delete
            if link in fav_items and fav_items[link].unfavorited_at is None:
                continue
            # Recently unfavorited: grace period from unfavorited_at (regardless of article age)
            if link in fav_items and fav_items[link].unfavorited_at is not None:
                unfav_ts = fav_items[link].unfavorited_at.timestamp()
                if unfav_ts > read_cutoff:
                    continue  # still within grace period
                # Past grace period — clean up the FavoriteItem record and the article
                session.delete(fav_items[link])
                session.execute(text("DELETE FROM articleentity WHERE article_id = :aid"), {"aid": article.id})
                session.execute(text("DELETE FROM articleembedding WHERE article_id = :aid"), {"aid": article.id})
                session.execute(text("DELETE FROM vec_cached_articles WHERE rowid = :aid"), {"aid": article.id})
                session.delete(article)
                deleted += 1
                continue
            # Normal cleanup logic
            is_read = link in read_links
            if (is_read and article.published < read_cutoff) or (not is_read and article.published < unread_cutoff):
                session.execute(text("DELETE FROM articleentity WHERE article_id = :aid"), {"aid": article.id})
                session.execute(text("DELETE FROM articleembedding WHERE article_id = :aid"), {"aid": article.id})
                session.execute(text("DELETE FROM vec_cached_articles WHERE rowid = :aid"), {"aid": article.id})
                session.delete(article)
                deleted += 1
        session.commit()
    if deleted > 0: logger.info(f"Cleaned up {deleted} old articles.")

def call_llm(settings: GlobalSettings, user_message: str, system_prompt: str) -> str:
    # Always use the standard OpenAI/LiteLLM REST format
    headers = {
        "Authorization": f"Bearer {settings.api_key}",
        "Content-Type": "application/json"
    }

    clean_model = clean_model_id(settings.model_name)
    payload = {
        "model": clean_model,
        "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_message}],
        "max_tokens": 4000,
        "temperature": 0.7,
        "stream": False
    }

    t0 = time.time()
    try:
        response = requests.post(settings.api_endpoint, headers=headers, json=payload, timeout=180)
        if not response.ok:
            logger.error(f"LLM Rejected Payload. Status: {response.status_code}")
            logger.error(f"LLM Error Body: {response.text}")

        response.raise_for_status()
        data = response.json()
        usage = data.get("usage", {})
        latency_ms = round((time.time() - t0) * 1000, 1)
        logger.info("[LLM] %s", {
            "model": clean_model,
            "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
            "total_tokens": usage.get("total_tokens"),
            "latency_ms": latency_ms,
            "endpoint": settings.api_endpoint,
        })
        return data['choices'][0]['message']['content']

    except Exception as e:
        logger.error(f"LLM Call Failed: {e}")
        raise e



def save_rss_file(collection, cluster_items: list):
    """Save digest as RSS with one <item> per cluster.

    cluster_items: list of (title: str, body_html: str) tuples, one per topic cluster.
    """
    os.makedirs("/app/data/feeds", exist_ok=True)
    filename = f"/app/data/feeds/{collection.slug}.xml"
    now_str = datetime.datetime.now().strftime("%a, %d %b %Y %H:%M:%S GMT")
    run_ts = int(time.time())

    items_xml = ""
    for idx, (topic_title, body_html) in enumerate(cluster_items):
        unique_id = f"{collection.slug}-{run_ts}-{idx}"
        safe_title = html.escape(topic_title)
        items_xml += f"""
        <item>
            <title>{safe_title}</title>
            <link>http://localhost/digest/{unique_id}</link>
            <description><![CDATA[{body_html}]]></description>
            <pubDate>{now_str}</pubDate>
            <guid>{unique_id}</guid>
        </item>"""

    xml = f"""<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
    <channel>
        <title>{collection.name} Digest</title>
        <link>http://localhost</link>
        <description>AI Generated Digest</description>
        <lastBuildDate>{now_str}</lastBuildDate>{items_xml}
    </channel>
</rss>"""
    with open(filename, "w") as f:
        f.write(xml)

def generate_digest_for_collection(collection_id: int):
    logger.info(f"[Digest] 🚀 Starting generation for Collection ID: {collection_id}")
    with Session(engine) as session:
        col = session.get(Collection, collection_id)
        if not col:
            logger.error(f"[Digest] Collection {collection_id} not found.")
            return
        col.is_generating = True
        session.add(col); session.commit()

    try:
        with Session(engine) as session:
            collection = session.get(Collection, collection_id)
            settings = get_settings(session)
            all_entries = []
            now = datetime.datetime.now()

            logger.info(f"[Digest] 📡 Fetching {len(collection.feeds)} source feeds in parallel...")

            # 1. Fetch all feeds in parallel, keeping track of the specific Feed object
            with concurrent.futures.ThreadPoolExecutor(max_workers=15) as executor:
                future_to_feed = {
                    executor.submit(fetch_external_feed, feed.url, feed.etag, feed.last_modified): feed
                    for feed in collection.feeds
                }

                for future in concurrent.futures.as_completed(future_to_feed):
                    feed = future_to_feed[future]
                    try:
                        parsed = future.result()
                        if parsed is _FEED_NOT_MODIFIED:
                            logger.info(f"[Digest] {feed.url} — not modified (304), using cached entries.")
                            parsed = None  # fall through; no new entries to add
                        if parsed:
                            # Persist updated conditional-request tokens
                            if getattr(parsed, '_ff_etag', None) or getattr(parsed, '_ff_last_modified', None):
                                db_feed = session.get(Feed, feed.id)
                                if db_feed:
                                    if parsed._ff_etag:
                                        db_feed.etag = parsed._ff_etag
                                    if parsed._ff_last_modified:
                                        db_feed.last_modified = parsed._ff_last_modified
                                    session.add(db_feed)
                            for entry in parsed.entries:
                                include_entry = True

                                # Filter by Age
                                if collection.filter_age != "all":
                                    published = None
                                    if hasattr(entry, 'published_parsed') and entry.published_parsed:
                                        published = datetime.datetime.fromtimestamp(time.mktime(entry.published_parsed))
                                    elif hasattr(entry, 'updated_parsed') and entry.updated_parsed:
                                        published = datetime.datetime.fromtimestamp(time.mktime(entry.updated_parsed))

                                    if published:
                                        if collection.filter_age == "24h" and (now - published > datetime.timedelta(hours=24)):
                                            include_entry = False
                                        elif collection.filter_age == "new" and (collection.last_run and published <= collection.last_run):
                                            include_entry = False

                                if not include_entry: continue

                                # --- Postlight Auto-Scrape (cache-first) ---
                                text_content = entry.get('summary', '') or entry.get('description', '') or ''

                                if feed.auto_scrape and entry.link:
                                    try:
                                        # Check for cached scraped content first
                                        with Session(engine) as scrape_session:
                                            cached_art = scrape_session.exec(
                                                select(CachedArticle).where(CachedArticle.link == entry.link)
                                            ).first()
                                        if cached_art and cached_art.scraped_content:
                                            logger.info(f"[Auto-Scrape] Using cached content for: {entry.title}")
                                            text_content = cached_art.scraped_content
                                        else:
                                            logger.info(f"[Auto-Scrape] Fetching full content for: {entry.title}")
                                            scraped_html = scrape_article_html(entry.link)
                                            text_content = scraped_html
                                            # Save to cache if article exists in DB
                                            with Session(engine) as scrape_session:
                                                art = scrape_session.exec(
                                                    select(CachedArticle).where(CachedArticle.link == entry.link)
                                                ).first()
                                                if art and not art.scraped_content:
                                                    art.scraped_content = scraped_html
                                                    scrape_session.add(art)
                                                    scrape_session.commit()
                                    except Exception as e:
                                        logger.warning(f"[Auto-Scrape] Failed to scrape {entry.link}, falling back to summary.")

                                # Filter by Focus Keywords
                                if collection.focus_keywords and collection.focus_keywords.strip():
                                    keywords = [k.strip().lower() for k in collection.focus_keywords.split(",") if k.strip()]
                                    if keywords:
                                        text_to_search = f"{entry.title} {text_content}".lower()
                                        if not any(kw in text_to_search for kw in keywords):
                                            continue

                                # Clean Text
                                limit = collection.context_length
                                if "<" in text_content:
                                    text_content = BeautifulSoup(text_content, "html.parser").get_text(separator=" ", strip=True)

                                if limit > 0 and len(text_content) > limit:
                                    text_content = text_content[:limit] + "..."

                                all_entries.append({
                                    "timestamp": published or now,
                                    "title": entry.title,
                                    "link": entry.link,
                                    "text": text_content,
                                    "formatted": f"Title: {entry.title}\nLink: {entry.link}\nText: {text_content}\n"
                                })
                    except Exception as e:
                        logger.warning(f"[Digest] ⚠ Error processing feed {feed.url}: {e}")

            logger.info(f"[Digest] 🔍 Found {len(all_entries)} valid articles.")

            if not all_entries:
                logger.info("[Digest] 🛑 No recent articles found to summarize. Aborting.")
                return

            all_entries.sort(key=lambda x: x["timestamp"], reverse=True)
            if collection.filter_max_articles > 0:
                all_entries = all_entries[:collection.filter_max_articles]
            all_entries = all_entries[:100]

            # --- Cluster articles; embeddings stored AFTER generation to keep RAG search space historical-only ---
            article_clusters, current_embeddings = cluster_articles(
                all_entries,
                min_cluster_size=collection.hdbscan_min_cluster_size,
                max_per_topic=collection.max_articles_per_topic,
                min_samples=collection.hdbscan_min_samples,
                cluster_selection_epsilon=collection.hdbscan_cluster_selection_epsilon,
                cluster_selection_method=collection.hdbscan_cluster_selection_method,
            )









            # --- Profile each cluster for entity-guided RAG ---
            cluster_entity_profiles: List[List[str]] = []
            try:
                with Session(engine) as profile_session:
                    for cluster_articles_list, _ in article_clusters:
                        cluster_links = [a["link"] for a in cluster_articles_list]
                        art_ids = profile_session.exec(
                            select(CachedArticle.id).where(CachedArticle.link.in_(cluster_links))
                        ).all()
                        entity_names = profile_cluster(list(art_ids), profile_session)
                        cluster_entity_profiles.append(entity_names)
            except Exception as e:
                logger.warning(f"[NLP] Entity profiling failed, falling back to pure vector RAG: {e}")
                cluster_entity_profiles = [[] for _ in article_clusters]

            # Safeguard: Override legacy prompts (both the "3-5 categories" one AND the "bulleted list of links" one)
            active_prompt = collection.system_prompt
            if active_prompt and ("3-5 logical categories" in active_prompt or "provide a bulleted list" in active_prompt):
                active_prompt = INITIAL_SYSTEM_PROMPT

            logger.info(f"[Digest] 🧠 Firing {len(article_clusters)} parallel LLM calls for each topic cluster...")

            # Define the worker function: two LLM calls per cluster
            def process_cluster(cluster_embedding_entities):
                cluster, center_embedding, entity_names = cluster_embedding_entities

                # RAG: retrieve historical context using entity profile + cluster center embedding
                historical = []
                if collection.rag_top_k > 0:
                    historical = retrieve_historical_context(
                        center_embedding,
                        collection.id,
                        collection.rag_top_k,
                        collection.rag_min_similarity,
                        entity_names=entity_names or None,
                        filter_age=collection.filter_age,
                        last_run=collection.last_run,
                    )

                # 1. Title call: article titles only → short punchy headline
                titles_block = "\n".join(f"- {a['title']}" for a in cluster)
                topic_title = call_llm(
                    settings,
                    f"Article titles:\n{titles_block}",
                    TITLE_SYSTEM_PROMPT,
                ).strip().strip('"').strip("'")

                # 2. Narrative call: full article text + RAG context → cohesive paragraph
                context = "\n".join([a["formatted"] for a in cluster])

                historical_block = ""
                if historical:
                    hist_parts = [
                        f"Title: {h['title']}\nURL: {h['url']}\nSummary: {h['content']}"
                        for h in historical
                    ]
                    historical_block = (
                        "\n\n<historical_context>\n"
                        + "\n---\n".join(hist_parts)
                        + "\n</historical_context>"
                    )

                user_msg = (
                    f"Here are the related articles for this topic:\n\n{context}"
                    + historical_block
                    + "\n\nWrite the narrative paragraph for this topic."
                )

                llm_narrative = f"<p>{html.escape(call_llm(settings, user_msg, active_prompt).strip())}</p>"

                # 3. Programmatically build the Sources list
                sources_html = "\n<h5 style='margin-top: 1rem; margin-bottom: 0.5rem; color: #888;'>Sources:</h5>\n<ul style='font-size: 0.9rem; margin-bottom: 1.5rem;'>\n"
                for article in cluster:
                    safe_title = html.escape(article['title'])
                    safe_link = article['link']
                    sources_html += f"    <li style='margin-bottom: 0.25rem;'><a href='{safe_link}' target='_blank' style='color: #1095c1; text-decoration: none;'>{safe_title}</a></li>\n"
                sources_html += "</ul>\n"

                # 4. Programmatically build the Context (RAG) section
                context_html = ""
                if historical:
                    context_html = "\n<h5 style='margin-top: 1rem; margin-bottom: 0.5rem; color: #888;'>Context:</h5>\n<ul style='font-size: 0.9rem; margin-bottom: 1.5rem;'>\n"
                    for h in historical:
                        safe_title = html.escape(h['title'])
                        safe_link = h['url']
                        context_html += f"    <li style='margin-bottom: 0.25rem;'><a href='{safe_link}' target='_blank' style='color: #888; text-decoration: none;'>{safe_title}</a></li>\n"
                    context_html += "</ul>\n"

                body_html = f"{llm_narrative}\n{sources_html}{context_html}"
                return (topic_title, body_html)

            # Fire off the LLM calls simultaneously (2 calls per cluster, still parallelised across clusters)
            with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
                cluster_items = list(executor.map(
                    process_cluster,
                    [(c, e, p) for (c, e), p in zip(article_clusters, cluster_entity_profiles)]
                ))

            # Store today's embeddings NOW — after retrieval — so they don't pollute the RAG search space
            _store_article_vectors(all_entries, current_embeddings, collection.id)

            logger.info("[Digest] ✅ Multi-Topic LLM generation successful! Saving RSS digest...")
            save_rss_file(collection, cluster_items)

            collection.last_run = datetime.datetime.now()
            session.add(collection); session.commit()

            # Sync to cache
            from threading import Thread
            Thread(target=sync_all_feeds).start()

    except Exception as e:
        logger.error(f"[Digest] 💥 Critical failure during generation: {e}")

    finally:
        with Session(engine) as session:
            col = session.get(Collection, collection_id)
            if col:
                col.is_generating = False
                session.add(col)
                session.commit()

def scheduled_checker():
    now = datetime.datetime.now()
    with Session(engine) as session:
        # NEW: We added a .where() clause so the database only returns active collections
        collections = session.exec(select(Collection).where(Collection.is_active == True)).all()
        
        for col in collections:
            if col.is_generating: continue
            
            try:
                target_hour, target_minute = map(int, col.schedule_time.split(":"))
                target_today = now.replace(hour=target_hour, minute=target_minute, second=0, microsecond=0)
                
                if now >= target_today:
                    should_run = False
                    if not col.last_run: should_run = True
                    elif col.last_run < target_today: should_run = True
                    
                    if should_run:
                        from threading import Thread
                        t = Thread(target=generate_digest_for_collection, args=(col.id,))
                        t.start()
            except Exception: pass



def upgrade_db_schema(engine):
    """Automatically adds missing columns to existing SQLite tables."""
    logger.info("Checking database schema for required upgrades...")
    inspector = inspect(engine)
    
    with Session(engine) as session:
        for table_name, table in SQLModel.metadata.tables.items():
            if not inspector.has_table(table_name):
                continue
            
            existing_columns = [col['name'] for col in inspector.get_columns(table_name)]
            
            for column in table.columns:
                if column.name not in existing_columns:
                    col_type = column.type.compile(engine.dialect)
                    try:
                        # Add the missing column safely
                        session.exec(text(f"ALTER TABLE {table_name} ADD COLUMN {column.name} {col_type}"))
                        logger.info(f"✨ Auto-Migrated: Added missing column '{column.name}' to '{table_name}'")
                    except Exception as e:
                        logger.error(f"Failed to migrate column {column.name} in {table_name}: {e}")
        session.commit()

# --- RAG Pipeline ---

def _store_article_vectors(articles: List[dict], embeddings, collection_id: int):
    """Upsert article embeddings into ArticleVector table and the vec_articles virtual table."""
    with Session(engine) as session:
        stored = 0
        for article, emb in zip(articles, embeddings):
            existing = session.exec(
                select(ArticleVector)
                .where(ArticleVector.url == article["link"])
                .where(ArticleVector.collection_id == collection_id)
            ).first()
            blob = array.array('f', emb.astype(float)).tobytes()
            if existing is None:
                av = ArticleVector(
                    collection_id=collection_id,
                    title=article["title"],
                    content=article["text"],
                    url=article["link"],
                    embedding=blob,
                    ingested_at=datetime.datetime.now(),
                )
                session.add(av)
                session.flush()
                session.execute(text(
                    "INSERT INTO vec_articles(rowid, embedding, collection_id) VALUES (:rid, :emb, :cid)"
                ), {"rid": av.id, "emb": blob, "cid": collection_id})
                stored += 1
            else:
                existing.embedding = blob
                existing.ingested_at = datetime.datetime.now()
                session.add(existing)
                session.execute(text(
                    "UPDATE vec_articles SET embedding = :emb WHERE rowid = :rid"
                ), {"emb": blob, "rid": existing.id})
        session.commit()
    logger.info(f"[RAG] Stored/updated {stored} new article vectors for collection {collection_id}.")


def retrieve_historical_context(
    query_embedding,
    collection_id: int,
    top_k: int,
    min_similarity: float = 0.60,
    entity_names: Optional[List[str]] = None,
    filter_age: str = "24h",
    last_run: Optional[datetime.datetime] = None,
) -> List[dict]:
    """Hybrid entity+vector search against vec_articles, with LRU bookkeeping on hits.

    If entity_names are provided, first finds historical ArticleVector entries whose
    CachedArticle source contains those entities (entity pre-filter), then ranks the
    matching articles by vector distance to the cluster centroid. Falls back to pure
    vector search when no entity matches are found.

    filter_age / last_run are used to exclude vectors ingested in the current
    collection window — preventing articles from the most recent run from appearing
    as historical context when a digest is re-run within the same period.
    """
    if top_k <= 0:
        return []
    t0 = time.time()
    blob = array.array('f', query_embedding.astype(float)).tobytes()

    # Compute the ingested_at cutoff: only retrieve vectors older than the collection window
    now = datetime.datetime.now()
    if filter_age == "24h":
        ingest_cutoff = now - datetime.timedelta(hours=24)
    elif filter_age == "new" and last_run:
        ingest_cutoff = last_run
    else:
        ingest_cutoff = None  # "all" — no restriction

    # Entity pre-filter: find ArticleVector IDs that contain the cluster's key entities
    entity_filter_ids: Optional[List[int]] = None
    if entity_names:
        try:
            cutoff_ts = time.time() - 86400  # only look at articles older than 24h
            with Session(engine) as ent_session:
                rows = ent_session.exec(
                    select(ArticleEntity.article_id)
                    .join(CachedArticle, CachedArticle.id == ArticleEntity.article_id)
                    .where(ArticleEntity.entity_text.in_(entity_names))
                    .where(CachedArticle.published < cutoff_ts)
                    .distinct()
                ).all()
                entity_filter_ids = list(rows) if rows else None
        except Exception as e:
            logger.warning(f"[RAG] Entity pre-filter failed: {e}")
            entity_filter_ids = None

    # Build the ingested_at filter clause for the SQL queries
    ingest_clause = ""
    ingest_params: dict = {}
    if ingest_cutoff is not None:
        ingest_clause = "AND av.ingested_at < :ingest_cutoff"
        ingest_params["ingest_cutoff"] = ingest_cutoff.isoformat()

    with Session(engine) as session:
        if entity_filter_ids:
            # Narrow vector search to entity-matched articles
            placeholders_in = ",".join(str(i) for i in entity_filter_ids)
            result_proxy = session.execute(text(f"""
                SELECT av.id, av.title, av.content, av.url,
                       vec_distance_cosine(va.embedding, :qemb) AS distance
                FROM vec_articles va
                JOIN articlevector av ON av.id = va.rowid
                WHERE va.collection_id = :cid
                  AND av.id IN ({placeholders_in})
                  {ingest_clause}
                ORDER BY distance ASC
                LIMIT :k
            """), {"qemb": blob, "cid": collection_id, "k": top_k * 3, **ingest_params})
        else:
            # Pure vector search — original behaviour
            result_proxy = session.execute(text(f"""
                SELECT av.id, av.title, av.content, av.url,
                       vec_distance_cosine(va.embedding, :qemb) AS distance
                FROM vec_articles va
                JOIN articlevector av ON av.id = va.rowid
                WHERE va.collection_id = :cid
                  {ingest_clause}
                ORDER BY distance ASC
                LIMIT :k
            """), {"qemb": blob, "cid": collection_id, "k": top_k * 3, **ingest_params})
        rows = result_proxy.fetchall()

        results = []
        for row in rows:
            similarity = 1.0 - (row.distance / 2.0)
            if similarity >= min_similarity:
                results.append(row)
                if len(results) >= top_k:
                    break

        retrieved_ids = [r.id for r in results]
        if retrieved_ids:
            placeholders = ",".join(str(i) for i in retrieved_ids)
            session.execute(text(
                f"UPDATE articlevector "
                f"SET last_retrieved_at = :now, retrieval_count = retrieval_count + 1 "
                f"WHERE id IN ({placeholders})"
            ), {"now": datetime.datetime.now()})
            session.commit()

    latency_ms = (time.time() - t0) * 1000
    logger.info(
        f"[RAG] Vector search: {latency_ms:.1f}ms | "
        f"retrieved={len(results)}/{top_k} | "
        f"collection={collection_id}"
    )
    return [{"title": r.title, "content": r.content, "url": r.url} for r in results]


def prune_stale_vectors(max_idle_days: int):
    """Delete ArticleVector rows not retrieved within max_idle_days."""
    cutoff = datetime.datetime.now() - datetime.timedelta(days=max_idle_days)
    with Session(engine) as session:
        stale = session.exec(
            select(ArticleVector).where(ArticleVector.last_retrieved_at < cutoff)
        ).all()
        evicted = len(stale)
        for av in stale:
            session.execute(text("DELETE FROM vec_articles WHERE rowid = :rid"), {"rid": av.id})
            session.delete(av)
        session.commit()
    logger.info(f"[RAG] Nightly GC: evicted {evicted} stale vectors (idle > {max_idle_days}d).")


def run_nightly_prune():
    """APScheduler target: prune stale vectors per collection's eviction setting."""
    with Session(engine) as session:
        collections = session.exec(select(Collection)).all()
    for col in collections:
        prune_stale_vectors(col.rag_eviction_days)


# ==========================================
#          DEMO MODE HOUSEKEEPING
# ==========================================

DEMO_SNAPSHOT_PATH = "/app/data/demo_snapshot.json"
DEMO_OPML_PATH = "/app/demo_feeds.opml"


def _import_opml_subscriptions(session: Session):
    """Import subscriptions from demo_feeds.opml if it exists."""
    if not os.path.exists(DEMO_OPML_PATH):
        return
    with open(DEMO_OPML_PATH, "r") as f:
        root = ET.fromstring(f.read())
    body = root.find("body")
    if body is None:
        return

    def parse_outlines(elements, current_category=None):
        for elem in elements:
            if not elem.tag.endswith("outline"):
                continue
            url = elem.get("xmlUrl") or elem.get("url")
            title = elem.get("text") or elem.get("title") or url
            cat = elem.get("category") or current_category
            if url:
                cat_id = None
                if cat:
                    cat_obj = session.exec(select(Category).where(Category.name == cat)).first()
                    if not cat_obj:
                        cat_obj = Category(name=cat)
                        session.add(cat_obj)
                        session.commit()
                        session.refresh(cat_obj)
                    cat_id = cat_obj.id
                if not session.exec(select(Subscription).where(Subscription.url == url)).first():
                    session.add(Subscription(url=url, title=title, category_id=cat_id))
            else:
                folder_title = elem.get("title") or elem.get("text")
                parse_outlines(list(elem), current_category=folder_title)

    parse_outlines(list(body))
    session.commit()


def demo_take_snapshot():
    """Capture the current DB state as the demo baseline (settings, categories,
    subscriptions, collections with their feeds). Called once on first boot."""
    logger.info("[Demo] Taking baseline snapshot...")
    with Session(engine) as session:
        settings = get_settings(session)
        snapshot = {
            "settings": {
                "api_endpoint": settings.api_endpoint,
                "model_name": settings.model_name,
                "default_schedule": settings.default_schedule,
                "default_context_length": settings.default_context_length,
                "default_filter_max": settings.default_filter_max,
                "default_filter_age": settings.default_filter_age,
                "default_system_prompt": settings.default_system_prompt,
                "retention_read_days": settings.retention_read_days,
                "retention_unread_days": settings.retention_unread_days,
                "reader_font_family": settings.reader_font_family,
                "reader_font_size": settings.reader_font_size,
                "reader_line_height": settings.reader_line_height,
                "pwa_offline_limit": settings.pwa_offline_limit,
                "default_focus_keywords": settings.default_focus_keywords,
            },
            "categories": [
                {"name": c.name}
                for c in session.exec(select(Category)).all()
            ],
            "subscriptions": [
                {
                    "url": s.url,
                    "title": s.title,
                    "category_name": (
                        session.get(Category, s.category_id).name
                        if s.category_id else None
                    ),
                }
                for s in session.exec(select(Subscription)).all()
            ],
            "collections": [],
        }
        for col in session.exec(select(Collection)).all():
            cat_name = session.get(Category, col.category_id).name if col.category_id else None
            snapshot["collections"].append({
                "name": col.name,
                "slug": col.slug,
                "schedule_time": col.schedule_time,
                "system_prompt": col.system_prompt,
                "context_length": col.context_length,
                "filter_max_articles": col.filter_max_articles,
                "filter_age": col.filter_age,
                "focus_keywords": col.focus_keywords,
                "max_articles_per_topic": col.max_articles_per_topic,
                "is_active": col.is_active,
                "rag_top_k": col.rag_top_k,
                "rag_min_similarity": col.rag_min_similarity,
                "rag_eviction_days": col.rag_eviction_days,
                "category_name": cat_name,
                "feeds": [f.url for f in col.feeds],
            })

    with open(DEMO_SNAPSHOT_PATH, "w") as f:
        json.dump(snapshot, f, indent=2)
    logger.info(f"[Demo] Snapshot saved: {len(snapshot['subscriptions'])} subscriptions, "
                f"{len(snapshot['collections'])} collections, {len(snapshot['categories'])} categories.")


def demo_restore_snapshot():
    """Restore the demo baseline: reset settings, remove user-added entities,
    re-create removed ones, fix moved feeds. Preserves CachedArticle and
    ArticleVector data for feeds that belong to the baseline."""
    if not os.path.exists(DEMO_SNAPSHOT_PATH):
        logger.warning("[Demo] No snapshot found, skipping restore.")
        return

    logger.info("[Demo] Restoring demo baseline...")
    with open(DEMO_SNAPSHOT_PATH, "r") as f:
        snapshot = json.load(f)

    with Session(engine) as session:
        # --- 1. Restore GlobalSettings (skip api_key — that comes from env) ---
        settings = get_settings(session)
        for key, val in snapshot["settings"].items():
            setattr(settings, key, val)
        session.add(settings)

        # --- 2. Restore Categories ---
        snapshot_cat_names = {c["name"] for c in snapshot["categories"]}
        existing_cats = session.exec(select(Category)).all()

        # Remove user-added categories
        for cat in existing_cats:
            if cat.name not in snapshot_cat_names:
                # Unlink anything referencing this category before deleting
                for sub in session.exec(select(Subscription).where(Subscription.category_id == cat.id)).all():
                    sub.category_id = None
                    session.add(sub)
                for col in session.exec(select(Collection).where(Collection.category_id == cat.id)).all():
                    col.category_id = None
                    session.add(col)
                for art in session.exec(select(CachedArticle).where(CachedArticle.category_id == cat.id)).all():
                    art.category_id = None
                    session.add(art)
                session.delete(cat)

        # Re-create missing categories
        for cat_data in snapshot["categories"]:
            if not session.exec(select(Category).where(Category.name == cat_data["name"])).first():
                session.add(Category(name=cat_data["name"]))
        session.commit()

        # Build a name->id lookup
        cat_lookup = {
            c.name: c.id for c in session.exec(select(Category)).all()
        }

        # --- 3. Restore Subscriptions ---
        snapshot_sub_urls = {s["url"] for s in snapshot["subscriptions"]}
        existing_subs = session.exec(select(Subscription)).all()

        # Remove user-added subscriptions and their articles
        for sub in existing_subs:
            if sub.url not in snapshot_sub_urls:
                # Delete cached articles that came from this subscription
                for art in session.exec(
                    select(CachedArticle).where(CachedArticle.feed_id == f"sub_{sub.id}")
                ).all():
                    session.delete(art)
                session.delete(sub)

        # Re-create missing or fix moved subscriptions
        for sub_data in snapshot["subscriptions"]:
            target_cat_id = cat_lookup.get(sub_data["category_name"]) if sub_data["category_name"] else None
            existing = session.exec(select(Subscription).where(Subscription.url == sub_data["url"])).first()
            if not existing:
                session.add(Subscription(
                    url=sub_data["url"],
                    title=sub_data["title"],
                    category_id=target_cat_id,
                ))
            else:
                # Fix title and category if user moved it
                existing.title = sub_data["title"]
                existing.category_id = target_cat_id
                session.add(existing)
        session.commit()

        # --- 4. Restore Collections and Feeds ---
        snapshot_col_slugs = {c["slug"] for c in snapshot["collections"]}
        existing_cols = session.exec(select(Collection)).all()

        # Remove user-added collections (and their feeds, vectors, cached articles)
        for col in existing_cols:
            if col.slug not in snapshot_col_slugs:
                for feed in col.feeds:
                    session.delete(feed)
                # Remove vectors for this collection
                session.execute(
                    text("DELETE FROM vec_articles WHERE rowid IN "
                         "(SELECT id FROM articlevector WHERE collection_id = :cid)"),
                    {"cid": col.id},
                )
                for av in session.exec(select(ArticleVector).where(ArticleVector.collection_id == col.id)).all():
                    session.delete(av)
                # Remove generated digest articles
                for art in session.exec(
                    select(CachedArticle).where(CachedArticle.feed_id == f"col_{col.id}")
                ).all():
                    session.delete(art)
                # Remove XML file
                xml_path = f"/app/data/feeds/{col.slug}.xml"
                if os.path.exists(xml_path):
                    os.remove(xml_path)
                session.delete(col)
        session.commit()

        # Re-create or restore baseline collections
        for col_data in snapshot["collections"]:
            target_cat_id = cat_lookup.get(col_data["category_name"]) if col_data["category_name"] else None
            existing_col = session.exec(
                select(Collection).where(Collection.slug == col_data["slug"])
            ).first()

            if not existing_col:
                existing_col = Collection(
                    name=col_data["name"],
                    slug=col_data["slug"],
                )
                session.add(existing_col)
                session.commit()
                session.refresh(existing_col)

            # Restore all collection properties
            existing_col.name = col_data["name"]
            existing_col.schedule_time = col_data["schedule_time"]
            existing_col.system_prompt = col_data["system_prompt"]
            existing_col.context_length = col_data["context_length"]
            existing_col.filter_max_articles = col_data["filter_max_articles"]
            existing_col.filter_age = col_data["filter_age"]
            existing_col.focus_keywords = col_data["focus_keywords"]
            existing_col.max_articles_per_topic = col_data["max_articles_per_topic"]
            existing_col.is_active = col_data["is_active"]
            existing_col.rag_top_k = col_data["rag_top_k"]
            existing_col.rag_min_similarity = col_data["rag_min_similarity"]
            existing_col.rag_eviction_days = col_data["rag_eviction_days"]
            existing_col.category_id = target_cat_id
            session.add(existing_col)
            session.commit()

            # Restore feeds: remove extras, add missing
            snapshot_feed_urls = set(col_data["feeds"])
            current_feeds = session.exec(
                select(Feed).where(Feed.collection_id == existing_col.id)
            ).all()
            for feed in current_feeds:
                if feed.url not in snapshot_feed_urls:
                    session.delete(feed)
            current_feed_urls = {f.url for f in current_feeds}
            for feed_url in snapshot_feed_urls:
                if feed_url not in current_feed_urls:
                    session.add(Feed(url=feed_url, collection_id=existing_col.id))
            session.commit()

        # --- 5. Clear read state so the demo feels fresh ---
        session.execute(text("DELETE FROM readitem"))
        session.commit()

    logger.info("[Demo] Baseline restored successfully.")


# Lazy-load the model so it doesn't slow down FastAPI startup
_embedding_model = None

def get_embedding_model():
    global _embedding_model
    if _embedding_model is None:
        logger.info("[Clustering] Loading MiniLM embedding model into memory...")
        _embedding_model = SentenceTransformer('all-MiniLM-L6-v2')
    return _embedding_model


_spacy_model = None

def get_spacy_model():
    global _spacy_model
    if _spacy_model is None:
        logger.info("[NLP] Loading spaCy en_core_web_sm model into memory...")
        _spacy_model = spacy.load("en_core_web_sm")
    return _spacy_model


def process_article_nlp(article: CachedArticle, session: Session) -> None:
    """
    Run TextBlob sentiment, spaCy NER, and MiniLM embedding for a CachedArticle.
    Each NLP step is individually try/excepted — failures are logged and non-fatal.
    """
    # Guard: skip if already processed
    existing = session.exec(
        select(ArticleEmbedding).where(ArticleEmbedding.article_id == article.id)
    ).first()
    if existing:
        return

    article_text = article.scraped_content or article.display_body or ""
    if not article_text:
        return

    # 1. Subjectivity score via TextBlob
    try:
        article.subjectivity_score = TextBlob(article_text).sentiment.subjectivity
        session.add(article)
    except Exception as e:
        logger.warning(f"[NLP] TextBlob failed for article {article.id}: {e}")

    # 2. spaCy NER — PERSON / ORG / GPE only, deduplicated
    try:
        nlp = get_spacy_model()
        doc = nlp(article_text[:10000])
        seen: set = set()
        for ent in doc.ents:
            if ent.label_ not in ("PERSON", "ORG", "GPE"):
                continue
            key = (ent.text.strip(), ent.label_)
            if key in seen:
                continue
            seen.add(key)
            session.add(ArticleEntity(
                article_id=article.id,
                entity_text=ent.text.strip(),
                entity_label=ent.label_,
            ))
    except Exception as e:
        logger.warning(f"[NLP] spaCy NER failed for article {article.id}: {e}")

    # 3. Embedding — encode first ~512 tokens (sentence-transformers truncates internally)
    try:
        model = get_embedding_model()
        emb = model.encode(article_text[:4096])
        blob = array.array('f', emb.astype(float)).tobytes()

        ae = ArticleEmbedding(article_id=article.id, embedding=blob)
        session.add(ae)
        session.flush()  # needed to get ae.id

        # sqlite-vec virtual tables don't support UPSERT; delete then insert
        session.execute(text(
            "DELETE FROM vec_cached_articles WHERE rowid = :rid"
        ), {"rid": article.id})
        session.execute(text(
            "INSERT INTO vec_cached_articles(rowid, embedding, article_id) "
            "VALUES (:rid, :emb, :aid)"
        ), {"rid": article.id, "emb": blob, "aid": article.id})
    except Exception as e:
        logger.warning(f"[NLP] Embedding failed for article {article.id}: {e}")


EMBEDDING_BATCH_SIZE = 16


def process_article_nlp_batch(articles: List[CachedArticle], session: Session) -> None:
    """
    Process a list of CachedArticle objects through the NLP pipeline.
    Commits every EMBEDDING_BATCH_SIZE articles to bound transaction size.
    """
    if not articles:
        return

    # Filter to only unprocessed articles
    unprocessed = []
    for art in articles:
        existing = session.exec(
            select(ArticleEmbedding).where(ArticleEmbedding.article_id == art.id)
        ).first()
        if not existing:
            unprocessed.append(art)

    if not unprocessed:
        return

    logger.info(f"[NLP] Processing {len(unprocessed)} new articles through NLP pipeline...")

    for i in range(0, len(unprocessed), EMBEDDING_BATCH_SIZE):
        batch = unprocessed[i:i + EMBEDDING_BATCH_SIZE]
        for article in batch:
            try:
                process_article_nlp(article, session)
            except Exception as e:
                logger.warning(f"[NLP] Batch NLP failed for article {article.id}: {e}")
        try:
            session.commit()
        except Exception as e:
            logger.error(f"[NLP] Batch commit failed: {e}")
            session.rollback()

    logger.info(f"[NLP] Batch NLP processing complete for {len(unprocessed)} articles.")


def profile_cluster(article_ids: List[int], session: Session) -> List[str]:
    """
    Return the top 5 most frequent entity_text values across a cluster's articles.
    """
    if not article_ids:
        return []
    try:
        rows = session.exec(
            select(ArticleEntity).where(ArticleEntity.article_id.in_(article_ids))
        ).all()

        freq: dict = {}
        for row in rows:
            key = (row.entity_text, row.entity_label)
            freq[key] = freq.get(key, 0) + 1

        top = sorted(freq.items(), key=lambda x: x[1], reverse=True)[:5]
        return [k[0] for k, _ in top]
    except Exception as e:
        logger.warning(f"[NLP] profile_cluster failed: {e}")
        return []


def cluster_articles(
    articles: List[dict],
    min_cluster_size: int = 3,
    max_per_topic: int = 5,
    min_samples: int = 0,
    cluster_selection_epsilon: float = 0.0,
    cluster_selection_method: str = "eom",
) -> tuple:
    """Groups articles using HDBSCAN (density-based; no fixed k).
    Returns (clusters_with_centers, embeddings) where clusters_with_centers is a
    list of (cluster_articles, center_embedding) tuples and embeddings is the full
    numpy array (used by the caller to store vectors after generation).
    Noise points (label -1) are silently discarded.

    Embeddings are L2-normalized before clustering so that Euclidean distance
    behaves identically to Cosine distance — the correct metric for MiniLM vectors."""
    # Normalize/coerce params — DB columns added via ALTER TABLE may be NULL on old rows
    min_cluster_size = max(2, int(min_cluster_size or 3))
    min_samples = max(0, int(min_samples or 0))
    cluster_selection_epsilon = max(0.0, float(cluster_selection_epsilon or 0.0))
    cluster_selection_method = cluster_selection_method if cluster_selection_method in ("eom", "leaf") else "eom"

    model = get_embedding_model()
    texts_to_embed = [f"{a['title']}. {a['text']}" for a in articles]

    logger.info(f"[Clustering] Embedding {len(articles)} articles for semantic analysis...")
    embeddings = model.encode(texts_to_embed)

    # L2-normalize so Euclidean distance == Cosine distance (correct for MiniLM)
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    embeddings_norm = embeddings / np.maximum(norms, 1e-10)

    # Degenerate case: too few articles to cluster
    if len(articles) <= min_cluster_size:
        center = np.mean(embeddings_norm, axis=0)
        return [(articles[:max_per_topic], center)], embeddings_norm

    # min_samples=0 means "let HDBSCAN use its default (same as min_cluster_size)"
    effective_min_samples = min_samples if min_samples > 0 else None

    logger.info(
        f"[Clustering] Running HDBSCAN (min_cluster_size={min_cluster_size}, "
        f"min_samples={effective_min_samples}, epsilon={cluster_selection_epsilon}, "
        f"method={cluster_selection_method})..."
    )
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=effective_min_samples,
        cluster_selection_epsilon=cluster_selection_epsilon,
        cluster_selection_method=cluster_selection_method,
        metric="euclidean",
    )
    clusterer.fit(embeddings_norm)
    labels = clusterer.labels_

    # Group by label, skip noise (-1)
    clusters: dict = {}
    for idx, label in enumerate(labels):
        if label == -1:
            continue
        clusters.setdefault(label, []).append(idx)

    # Fallback: if HDBSCAN found no clusters, return all articles as one group
    if not clusters:
        logger.info("[Clustering] HDBSCAN found no clusters; returning all articles as one group.")
        center = np.mean(embeddings_norm, axis=0)
        result = (articles[:max_per_topic], center)
        del clusterer
        gc.collect()
        return [result], embeddings_norm

    final_clusters = []
    for label, indices in clusters.items():
        cluster_embs = embeddings_norm[indices]
        center_embedding = np.mean(cluster_embs, axis=0)
        cluster_articles_list = [articles[i] for i in indices[:max_per_topic]]
        final_clusters.append((cluster_articles_list, center_embedding))

    logger.info(f"[Clustering] HDBSCAN found {len(final_clusters)} clusters.")
    del clusterer
    gc.collect()

    return final_clusters, embeddings_norm








@asynccontextmanager
async def lifespan(app: FastAPI):
    SQLModel.metadata.create_all(engine)
    upgrade_db_schema(engine)

    with Session(engine) as session:
        session.execute(text(
            "CREATE VIRTUAL TABLE IF NOT EXISTS vec_articles "
            "USING vec0(embedding float[384], collection_id integer)"
        ))
        session.commit()
    logger.info("[RAG] vec_articles virtual table ready.")

    with Session(engine) as session:
        session.execute(text(
            "CREATE VIRTUAL TABLE IF NOT EXISTS vec_cached_articles "
            "USING vec0(embedding float[384], article_id integer)"
        ))
        session.commit()
    logger.info("[NLP] vec_cached_articles virtual table ready.")

    with Session(engine) as session:
        settings = get_settings(session)
       
        # --- NEW: Auto-populate from Environment Variables ---
        env_base_url = os.environ.get("OPENAI_BASE_URL")
        env_api_key = os.environ.get("OPENAI_API_KEY")
        
        updated = False
        
        # If an env var exists, and it doesn't match the DB, the env var wins!
        if env_base_url and settings.api_endpoint != env_base_url:
            settings.api_endpoint = env_base_url
            updated = True
            
        if env_api_key and settings.api_key != env_api_key:
            settings.api_key = env_api_key
            updated = True

        if updated:
            session.add(settings)
        
        if settings.model_name:
            cln = clean_model_id(settings.model_name)
            if settings.model_name != cln: 
                settings.model_name = cln
                session.add(settings)
                
        # (Keep the rest of your lifespan logic identical...)
        cols = session.exec(select(Collection)).all()
        for c in cols: c.is_generating = False; session.add(c)
        session.commit()
        
        # Keep original defaults just in case it's a fresh DB
        if not session.exec(select(Category)).first():
            session.add(Category(name="Tech")); session.add(Category(name="News")); session.commit()
            
        # NEW: Guarantee the "AI Digest" category always exists
        if not session.exec(select(Category).where(Category.name == "AI Digest")).first():
            session.add(Category(name="AI Digest"))
            session.commit()

    # --- Demo Mode: import OPML and take snapshot on first boot ---
    _demo_mode_boot = os.environ.get("DEMO_MODE", "false").lower() == "true"
    if _demo_mode_boot:
        if os.path.exists(DEMO_OPML_PATH):
            with Session(engine) as session:
                _import_opml_subscriptions(session)
            logger.info("[Demo] OPML feeds imported from demo_feeds.opml.")
        if not os.path.exists(DEMO_SNAPSHOT_PATH):
            demo_take_snapshot()
        else:
            logger.info("[Demo] Snapshot already exists, running restore to clean up any leftover state...")
            demo_restore_snapshot()

    scheduler = BackgroundScheduler()
    scheduler.add_job(scheduled_checker, 'interval', minutes=15)
    scheduler.add_job(sync_all_feeds, 'interval', minutes=15)
    scheduler.add_job(cleanup_old_articles, 'interval', hours=1)
    scheduler.add_job(run_nightly_prune, 'cron', hour=3, minute=0)
    if _demo_mode_boot:
        scheduler.add_job(demo_restore_snapshot, 'cron', hour=4, minute=0)
    scheduler.start()
    
    from threading import Thread
    Thread(target=sync_all_feeds).start()
    Thread(target=cleanup_old_articles).start()
    yield
    scheduler.shutdown()

app = FastAPI(lifespan=lifespan)
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import RedirectResponse as StarletteRedirect

DEMO_MODE = os.environ.get("DEMO_MODE", "false").lower() == "true"
DEV_MODE = os.environ.get("DEV_MODE", "false").lower() == "true"
DEMO_USER = os.environ.get("DEMO_USER", "demo")
DEMO_PASS = os.environ.get("DEMO_PASS", "demo")
_DEMO_TOKEN = hashlib.sha256(f"{DEMO_USER}:{DEMO_PASS}".encode()).hexdigest()

# --- CSRF Protection ---
_CSRF_COOKIE = "csrf_token"
_CSRF_HEADER = "X-CSRF-Token"
_CSRF_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

def _generate_csrf_token() -> str:
    return secrets.token_hex(32)

def _csrf_token_matches(cookie_val: str, header_val: str) -> bool:
    if not cookie_val or not header_val:
        return False
    return hmac.compare_digest(cookie_val, header_val)

class CSRFMiddleware(BaseHTTPMiddleware):
    HANDLER_VALIDATED = {"/login"}

    async def dispatch(self, request, call_next):
        if request.method not in _CSRF_SAFE_METHODS and request.url.path not in self.HANDLER_VALIDATED:
            cookie_token = request.cookies.get(_CSRF_COOKIE)
            header_token = request.headers.get(_CSRF_HEADER)
            if not _csrf_token_matches(cookie_token, header_token):
                if request.url.path.startswith("/api/"):
                    return Response(content='{"detail":"CSRF validation failed"}', status_code=403, media_type="application/json")
                if request.headers.get("HX-Request"):
                    return HTMLResponse(
                        '<span style="color:#ff4444;">Session expired. Please <a href="/" style="color:var(--primary);">reload the page</a>.</span>',
                        status_code=403,
                    )
                return Response("CSRF validation failed", status_code=403)

        response = await call_next(request)

        if not request.cookies.get(_CSRF_COOKIE):
            response.set_cookie(
                _CSRF_COOKIE,
                _generate_csrf_token(),
                httponly=False,
                secure=not DEV_MODE,
                samesite="lax",
                max_age=86400,
                path="/",
            )

        return response

class DemoAuthMiddleware(BaseHTTPMiddleware):
    OPEN_PREFIXES = ("/login", "/static/", "/feeds/", "/manifest.json", "/sw.js", "/api/auth/")

    async def dispatch(self, request, call_next):
        if not DEMO_MODE:
            return await call_next(request)
        path = request.url.path
        if any(path.startswith(p) for p in self.OPEN_PREFIXES):
            return await call_next(request)
        if request.cookies.get("demo_token") == _DEMO_TOKEN:
            return await call_next(request)
        # Return 401 JSON for API requests so Next.js can handle auth
        if path.startswith("/api/"):
            return Response(content='{"detail":"Unauthorized"}', status_code=401, media_type="application/json")
        return StarletteRedirect("/login", status_code=303)

app.add_middleware(CSRFMiddleware)
app.add_middleware(DemoAuthMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://frontend:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="static"), name="static")

# ==========================================
#               READER ROUTES
# ==========================================
import re
from urllib.parse import urljoin, unquote, quote, urlparse

def extract_real_url(raw_url: str, base_url: str) -> str:
    """Uses Regex to aggressively extract true URLs from corrupted strings."""
    if not raw_url:
        return ""
        
    try:
        decoded = unquote(unquote(raw_url))
    except:
        decoded = raw_url
        
    # Sledgehammer: Find hidden absolute URLs inside garbage wrappers
    match = re.search(r'(https?://[^\s"\'\)\(\]]+)', decoded)
    if match:
        clean_url = match.group(1)
        return clean_url.rstrip('\\/"\'').replace('%22', '')
        
    # Fallback for clean relative URLs
    cleaned = decoded.strip(' "/\'()[]\n\r\t').replace('%22', '').replace('%3A', ':').replace('\\', '')
    if cleaned.startswith('//'):
        return 'https:' + cleaned
    if cleaned and not cleaned.startswith(('http', 'data:')):
        return urljoin(base_url, cleaned)
        
    return cleaned



def scrape_article_html(url: str) -> str:
    """
    Fetch and parse an article via the Postlight parser sidecar, then sanitize HTML for safe rendering.
    Returns sanitized HTML.
    """
    parser_api_url = f"http://parser:3000/parser?url={quote(url, safe='')}"
    response = requests.get(parser_api_url, timeout=30)
    response.raise_for_status()
    data = response.json()

    if "error" in data and data["error"]:
        raise RuntimeError(data.get("message", "Unknown Postlight parser error"))

    raw_html = data.get("content", "")
    if not raw_html:
        raise RuntimeError("Postlight Parser could not extract content from this page.")

    # Extract Lead Image Safely
    header_image_html = ""
    lead_image = extract_real_url(data.get("lead_image_url"), url)
    if lead_image and lead_image.startswith(("http://", "https://")):
        proxied_lead = "/reader/image_proxy?url=" + quote(lead_image, safe="")
        header_image_html = (
            f'<img src="{proxied_lead}" '
            f'style="max-width: 100%; height: auto; border-radius: 8px; '
            f'margin-bottom: 1.5rem; display: block; box-shadow: 0 4px 12px rgba(0,0,0,0.3);" '
            f'onerror="this.style.display=\'none\'" alt="Header Image"/>\n'
        )

    soup = BeautifulSoup(raw_html, 'html.parser')

    # Fix: remove scripts/styles/iframes so HTMX doesn't execute broken/malicious content
    for tag in soup.find_all(['script', 'style', 'iframe', 'noscript']):
        tag.decompose()

    # Fix: remove <picture> wrappers so images render predictably
    for picture in soup.find_all('picture'):
        img = picture.find('img')
        if img:
            picture.replace_with(img)
        else:
            picture.decompose()

    # Remove standalone <source> tags just in case
    for source in soup.find_all('source'):
        source.decompose()

    for a in soup.find_all('a'):
        href = extract_real_url(a.get('href'), url)
        if href:
            a['href'] = href
        a['target'] = '_blank'
        a['style'] = 'color: #1095c1; text-decoration: none;'

    for img in soup.find_all('img'):
        src = extract_real_url(img.get('src'), url)
        if src and src.startswith(("http://", "https://")):
            img['src'] = "/reader/image_proxy?url=" + quote(src, safe="")
        elif src and src.startswith("data:"):
            img['src'] = src  # inline base64 — pass through as-is
        else:
            img.decompose()
            continue

        img['loading'] = 'lazy'
        img['style'] = (
            'max-width: 100%; height: auto; border-radius: 8px; '
            'margin: 1.5rem auto; display: block; box-shadow: 0 4px 12px rgba(0,0,0,0.3);'
        )
        img['onerror'] = "this.style.display='none'"

        # Strip competing layout & responsive attributes
        for attr in ['class', 'width', 'height', 'srcset', 'sizes', 'referrerpolicy']:
            if attr in img.attrs:
                del img[attr]

    return header_image_html + str(soup)


def html_to_plain_text(html: str) -> str:
    soup = BeautifulSoup(html or "", 'html.parser')
    for tag in soup.find_all(['script', 'style', 'iframe', 'noscript']):
        tag.decompose()
    return soup.get_text(" ", strip=True)


def truncate_text(text: str, limit: int) -> str:
    if not text:
        return ""
    if len(text) <= limit:
        return text
    return text[:limit] + "... [Text Truncated]"


def _batch_scrape_subscription(sub_id: int):
    """
    Background job: scrape unscraped articles for a subscription, newest first.
    Rate-limited (2s between articles, 15s pause every 5 articles) to avoid hammering sites.
    Stops early if auto_scrape is turned off mid-run. Max 100 articles per invocation.
    """
    with _batch_scrape_lock:
        if sub_id in _active_batch_scrapes:
            logger.info(f"[Batch-Scrape] Sub {sub_id} already has a scrape job running, skipping.")
            return
        _active_batch_scrapes.add(sub_id)

    BATCH_SIZE = 5
    DELAY_BETWEEN_ARTICLES = 2.0
    DELAY_BETWEEN_BATCHES = 15.0
    MAX_ARTICLES = 100

    try:
        with Session(engine) as session:
            links = [
                a.link for a in session.exec(
                    select(CachedArticle)
                    .where(CachedArticle.feed_id == f"sub_{sub_id}")
                    .where(CachedArticle.scraped_content == None)
                    .order_by(CachedArticle.published.desc())
                    .limit(MAX_ARTICLES)
                ).all()
            ]

        if not links:
            logger.info(f"[Batch-Scrape] Sub {sub_id}: no unscraped articles found.")
            return

        logger.info(f"[Batch-Scrape] Sub {sub_id}: queued {len(links)} articles to scrape.")

        for i, link in enumerate(links):
            # Stop if auto_scrape was turned off
            with Session(engine) as session:
                sub = session.get(Subscription, sub_id)
                if not sub or not sub.auto_scrape:
                    logger.info(f"[Batch-Scrape] Sub {sub_id}: auto_scrape disabled, stopping early.")
                    break

            try:
                html = scrape_article_html(link)
                with Session(engine) as session:
                    art = session.exec(select(CachedArticle).where(CachedArticle.link == link)).first()
                    if art and not art.scraped_content:
                        art.scraped_content = html
                        session.add(art)
                        session.commit()
                logger.info(f"[Batch-Scrape] Sub {sub_id}: scraped {i+1}/{len(links)}")
            except Exception as e:
                logger.warning(f"[Batch-Scrape] Sub {sub_id}: failed {link}: {e}")

            if i < len(links) - 1:
                time.sleep(DELAY_BETWEEN_ARTICLES)
                if (i + 1) % BATCH_SIZE == 0:
                    logger.info(f"[Batch-Scrape] Sub {sub_id}: batch pause...")
                    time.sleep(DELAY_BETWEEN_BATCHES)

        logger.info(f"[Batch-Scrape] Sub {sub_id}: batch complete.")
    finally:
        with _batch_scrape_lock:
            _active_batch_scrapes.discard(sub_id)


@app.post("/reader/fetch_content")
def fetch_content(url: str = Form(...)):
    try:
        return scrape_article_html(url)
    except Exception as e:
        import traceback
        logger.error(f"Scrape Error: {traceback.format_exc()}")
        return f"<p style='color: #ff4444;'>Scrape Failed: {str(e)}</p>"


# ── Image proxy ────────────────────────────────────────────────────────────────

_IMAGE_CACHE: dict = {}        # sha256(url) -> (content_type, bytes)
_IMAGE_CACHE_ORDER: list = []  # LRU eviction order
_IMAGE_CACHE_MAX = 200

_PROXY_HEADERS = {
    "User-Agent": f"{FEEDFACTORY_UA} (image-proxy)",
    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
}

def _cache_put(url_hash: str, content_type: str, data: bytes):
    if url_hash in _IMAGE_CACHE:
        _IMAGE_CACHE_ORDER.remove(url_hash)
    elif len(_IMAGE_CACHE_ORDER) >= _IMAGE_CACHE_MAX:
        evict = _IMAGE_CACHE_ORDER.pop(0)
        _IMAGE_CACHE.pop(evict, None)
    _IMAGE_CACHE[url_hash] = (content_type, data)
    _IMAGE_CACHE_ORDER.append(url_hash)


@app.get("/reader/image_proxy")
def image_proxy(url: str):
    """Server-side image proxy: fetches remote images to bypass hotlink/CORS restrictions."""
    # Validate scheme
    try:
        parsed = urlparse(url)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid URL")

    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Only http/https URLs are allowed")

    hostname = parsed.hostname or ""
    if not hostname:
        raise HTTPException(status_code=400, detail="Invalid URL: no hostname")

    # SSRF guard: block requests to private/loopback addresses
    try:
        resolved_ip = socket.gethostbyname(hostname)
        ip_obj = ipaddress.ip_address(resolved_ip)
        if ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_link_local:
            raise HTTPException(status_code=403, detail="Access to private addresses forbidden")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=502, detail="Could not resolve image host")

    # Cache lookup
    url_hash = hashlib.sha256(url.encode()).hexdigest()
    if url_hash in _IMAGE_CACHE:
        content_type, data = _IMAGE_CACHE[url_hash]
        _IMAGE_CACHE_ORDER.remove(url_hash)
        _IMAGE_CACHE_ORDER.append(url_hash)
        return Response(content=data, media_type=content_type,
                        headers={"Cache-Control": "public, max-age=86400"})

    # Fetch from origin
    try:
        r = requests.get(url, headers=_PROXY_HEADERS, timeout=15,
                         allow_redirects=True, stream=True)
    except requests.exceptions.RequestException as exc:
        logger.warning(f"Image proxy fetch failed for {url}: {exc}")
        raise HTTPException(status_code=502, detail="Failed to fetch image")

    if r.status_code != 200:
        raise HTTPException(status_code=r.status_code, detail="Upstream image not available")

    content_type = r.headers.get("Content-Type", "application/octet-stream").split(";")[0].strip()
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="Upstream URL did not return an image")

    # Read body with 10 MB cap
    MAX_BYTES = 10 * 1024 * 1024
    chunks, total = [], 0
    for chunk in r.iter_content(chunk_size=8192):
        total += len(chunk)
        if total > MAX_BYTES:
            raise HTTPException(status_code=413, detail="Image too large to proxy")
        chunks.append(chunk)
    data = b"".join(chunks)

    _cache_put(url_hash, content_type, data)
    return Response(content=data, media_type=content_type,
                    headers={"Cache-Control": "public, max-age=86400"})




@app.get("/feeds/{slug}.xml")
def get_feed_xml(slug: str):
    slug = _sanitize_slug(slug)
    if not slug:
        raise HTTPException(status_code=400, detail="Invalid slug")
    path = f"/app/data/feeds/{slug}.xml"
    if not os.path.exists(path): return Response(content="<rss><channel><title>Generating...</title></channel></rss>", media_type="application/xml")
    with open(path, "r") as f: return Response(content=f.read(), media_type="application/xml")


# ==========================================
#               PWA ROUTES
# ==========================================

@app.get("/manifest.json")
def get_manifest():
    return {
        "name": "Feed Factory",
        "short_name": "FeedFactory",
        "start_url": "/",
        "display": "standalone",
        "background_color": "#141414",
        "theme_color": "#141414",
        # UPDATED: Now points to your static folder
        "icons": [{"src": "/static/logo.svg", "sizes": "512x512", "type": "image/svg+xml"}]
    }


@app.get("/sw.js", response_class=Response)
def get_sw():
    js = """
    const CACHE_NAME = 'feedfactory-pwa-v2';

    const APP_SHELL = [
        '/',
        '/reader/categories',
        '/static/logo.svg',
        '/manifest.json'
    ];

    // Rejects after `ms` milliseconds — used to race against stalled fetches
    function networkTimeout(ms) {
        return new Promise((_, reject) =>
            setTimeout(() => reject(new Error('network-timeout')), ms)
        );
    }

    // Tell all open client windows that we just served from cache
    async function notifyClientsOffline() {
        const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
        allClients.forEach(client => client.postMessage({ type: 'SW_SERVING_FROM_CACHE' }));
    }

    self.addEventListener('install', event => {
        self.skipWaiting();
        event.waitUntil(
            caches.open(CACHE_NAME).then(cache => {
                console.log('[SW] Pre-caching App Shell');
                return cache.addAll(APP_SHELL);
            })
        );
    });

    self.addEventListener('activate', event => {
        event.waitUntil(
            caches.keys().then(cacheNames => Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[SW] Removing old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            )).then(() => self.clients.claim())
        );
    });

    self.addEventListener('fetch', event => {
        if (event.request.method !== 'GET') return;

        event.respondWith(
            Promise.race([
                fetch(event.request),
                networkTimeout(3500)
            ])
            .then(response => {
                // Network won — refresh the cache entry and return the live response
                const resClone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
                return response;
            })
            .catch(async () => {
                // Network lost (hard error) or timed out (strained connection)
                const cachedResponse = await caches.match(event.request);
                if (cachedResponse) {
                    notifyClientsOffline();
                    return cachedResponse;
                }
                // Nothing in cache — for navigation requests serve the app shell root
                if (event.request.mode === 'navigate') {
                    notifyClientsOffline();
                    return caches.match('/');
                }
            })
        );
    });
    """
    return Response(content=js, media_type="application/javascript")


# ==========================================
#           JSON API ROUTES (Next.js)
# ==========================================

# --- Auth ---

@app.get("/api/auth/status")
def api_auth_status(request: Request):
    if DEMO_MODE:
        authenticated = request.cookies.get("demo_token") == _DEMO_TOKEN
        return {"demo_mode": True, "authenticated": authenticated, "demo_user": DEMO_USER, "demo_pass": DEMO_PASS}
    return {"demo_mode": False, "authenticated": True}

@app.post("/api/auth/login")
async def api_auth_login(request: Request):
    data = await request.json()
    username = data.get("username", "")
    password = data.get("password", "")
    if username == DEMO_USER and password == DEMO_PASS:
        response = Response(content='{"ok":true}', media_type="application/json")
        response.set_cookie("demo_token", _DEMO_TOKEN, httponly=True, secure=not DEV_MODE, samesite="lax", max_age=86400)
        return response
    return Response(content='{"detail":"Invalid credentials"}', status_code=401, media_type="application/json")

@app.post("/api/auth/logout")
def api_auth_logout():
    response = Response(content='{"ok":true}', media_type="application/json")
    response.delete_cookie("demo_token")
    return response


# --- Categories ---

@app.get("/api/categories")
def api_get_categories():
    with Session(engine) as session:
        categories = session.exec(select(Category).order_by(Category.name)).all()
        read_links = {r.item_link for r in session.exec(select(ReadItem)).all()}
        fav_links = {f.item_link for f in session.exec(select(FavoriteItem).where(FavoriteItem.unfavorited_at == None)).all()}
        articles = session.exec(select(CachedArticle)).all()

        unread_counts = {cat.id: 0 for cat in categories}
        unread_counts[None] = 0
        latest_timestamps = {cat.id: 0 for cat in categories}
        latest_timestamps[None] = 0
        latest_timestamps["all"] = 0
        total_unread = 0
        favorites_count = 0
        favorites_unread = 0

        for article in articles:
            cat_id = article.category_id
            pub = article.published
            if cat_id in latest_timestamps and pub > latest_timestamps[cat_id]:
                latest_timestamps[cat_id] = pub
            elif cat_id is None and pub > latest_timestamps[None]:
                latest_timestamps[None] = pub
            if pub > latest_timestamps["all"]:
                latest_timestamps["all"] = pub
            if article.link not in read_links:
                total_unread += 1
                if cat_id in unread_counts:
                    unread_counts[cat_id] += 1
                elif cat_id is None:
                    unread_counts[None] += 1
            if article.link in fav_links:
                favorites_count += 1
                if article.link not in read_links:
                    favorites_unread += 1

        has_uncategorized = unread_counts[None] > 0 or any(
            a.category_id is None for a in articles
        )
        result = [
            {
                "id": cat.id,
                "name": cat.name,
                "unread_count": unread_counts.get(cat.id, 0),
                "newest_ts": latest_timestamps.get(cat.id, 0),
            }
            for cat in categories
        ]
        return {
            "categories": result,
            "total_unread": total_unread,
            "newest_ts_all": latest_timestamps["all"],
            "uncategorized_unread": unread_counts[None],
            "has_uncategorized": has_uncategorized,
            "favorites_count": favorites_count,
            "favorites_unread": favorites_unread,
        }

@app.post("/api/categories")
async def api_add_category(request: Request):
    data = await request.json()
    name = data.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    with Session(engine) as session:
        existing = session.exec(select(Category).where(Category.name == name)).first()
        if existing:
            return {"id": existing.id, "name": existing.name}
        cat = Category(name=name)
        session.add(cat)
        session.commit()
        session.refresh(cat)
        return {"id": cat.id, "name": cat.name}

@app.patch("/api/categories/{cat_id}")
async def api_rename_category(cat_id: int, request: Request):
    data = await request.json()
    new_name = data.get("name", "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Name required")
    with Session(engine) as session:
        cat = session.get(Category, cat_id)
        if not cat:
            raise HTTPException(status_code=404)
        cat.name = new_name
        session.add(cat)
        session.commit()
        return {"id": cat.id, "name": cat.name}

@app.delete("/api/categories/{cat_id}")
def api_delete_category(cat_id: int):
    with Session(engine) as session:
        cat = session.get(Category, cat_id)
        if cat:
            for sub in session.exec(select(Subscription).where(Subscription.category_id == cat_id)).all():
                sub.category_id = None; session.add(sub)
            for col in session.exec(select(Collection).where(Collection.category_id == cat_id)).all():
                col.category_id = None; session.add(col)
            for art in session.exec(select(CachedArticle).where(CachedArticle.category_id == cat_id)).all():
                art.category_id = None; session.add(art)
            session.delete(cat)
            session.commit()
    return Response(status_code=204)

@app.post("/api/categories/{cat_id}/mark_read")
def api_mark_category_read(cat_id: str):
    with Session(engine) as session:
        read_links = {r.item_link for r in session.exec(select(ReadItem)).all()}
        query = select(CachedArticle)
        if cat_id == "none":
            query = query.where(CachedArticle.category_id == None)
        elif cat_id != "all":
            query = query.where(CachedArticle.category_id == int(cat_id))
        articles = session.exec(query).all()
        new_reads = [ReadItem(item_link=a.link) for a in articles if a.link not in read_links]
        if new_reads:
            session.add_all(new_reads)
            session.commit()
    return Response(status_code=204)


# --- Category Feeds (feed tiles) ---

@app.get("/api/categories/{category_id}/feeds")
def api_get_feeds_by_category(category_id: str):
    with Session(engine) as session:
        read_links = {r.item_link for r in session.exec(select(ReadItem)).all()}
        feeds_list = []

        cols = session.exec(select(Collection)).all()
        for col in cols:
            if (category_id == "all" or
                    (category_id == "none" and col.category_id is None) or
                    (category_id not in ["all", "none"] and str(col.category_id) == category_id)):
                kw_list = [k.strip() for k in (col.focus_keywords or "").split(",") if k.strip()]
                feeds_list.append({
                    "id": f"col_{col.id}", "name": col.name, "type": "collection",
                    "db_id": col.id, "url": "", "keywords": kw_list, "auto_scrape": False
                })

        subs = session.exec(select(Subscription)).all()
        for sub in subs:
            if (category_id == "all" or
                    (category_id == "none" and sub.category_id is None) or
                    (category_id not in ["all", "none"] and str(sub.category_id) == category_id)):
                feeds_list.append({
                    "id": f"sub_{sub.id}", "name": sub.title or sub.url, "type": "subscription",
                    "db_id": sub.id, "url": sub.url, "keywords": [], "auto_scrape": sub.auto_scrape
                })

        unread_counts = {f["id"]: 0 for f in feeds_list}
        total_unread = 0
        articles = session.exec(select(CachedArticle)).all()
        for article in articles:
            if article.link not in read_links:
                if article.feed_id in unread_counts:
                    unread_counts[article.feed_id] += 1
                if (category_id == "all" or
                        str(article.category_id) == category_id or
                        (category_id == "none" and article.category_id is None)):
                    total_unread += 1

        cat_name = "All Feeds"
        if category_id not in ["all", "none"]:
            cat = session.get(Category, int(category_id))
            if cat:
                cat_name = cat.name
        elif category_id == "none":
            cat_name = "Uncategorized"

        for f in feeds_list:
            f["unread_count"] = unread_counts.get(f["id"], 0)

        return {"feeds": feeds_list, "category_name": cat_name, "total_unread": total_unread}


# --- Subscriptions ---

@app.get("/api/subscriptions")
def api_list_subscriptions():
    with Session(engine) as session:
        subs = session.exec(select(Subscription).order_by(Subscription.title)).all()
        return [
            {"id": s.id, "url": s.url, "title": s.title, "category_id": s.category_id}
            for s in subs
        ]

@app.post("/api/subscriptions")
async def api_add_subscription(request: Request):
    data = await request.json()
    url = data.get("url", "").strip()
    category_id_raw = data.get("category_id")
    cat_id = int(category_id_raw) if category_id_raw and str(category_id_raw).isdigit() else None
    if not url:
        raise HTTPException(status_code=400, detail="URL required")
    with Session(engine) as session:
        existing = session.exec(select(Subscription).where(Subscription.url == url)).first()
        if existing:
            return {"id": existing.id, "url": existing.url, "title": existing.title, "category_id": existing.category_id}
        try:
            f = fetch_external_feed(url)
            title = f.feed.get('title', 'New Feed') if f else 'New Feed'
        except:
            title = 'New Feed'
        sub = Subscription(url=url, title=title, category_id=cat_id)
        session.add(sub)
        session.commit()
        session.refresh(sub)
    from threading import Thread
    Thread(target=sync_all_feeds).start()
    return {"id": sub.id, "url": sub.url, "title": sub.title, "category_id": sub.category_id}

@app.patch("/api/subscriptions/{sub_id}")
async def api_update_subscription(sub_id: int, request: Request):
    data = await request.json()
    category_id_raw = data.get("category_id")
    cat_id = int(category_id_raw) if category_id_raw and str(category_id_raw).isdigit() else None
    with Session(engine) as session:
        sub = session.get(Subscription, sub_id)
        if not sub:
            raise HTTPException(status_code=404)
        sub.category_id = cat_id
        session.add(sub)
        session.commit()
        return {"id": sub.id, "url": sub.url, "title": sub.title, "category_id": sub.category_id}

@app.post("/api/subscriptions/{sub_id}/toggle_scrape")
def api_toggle_subscription_scrape(sub_id: int):
    with Session(engine) as session:
        sub = session.get(Subscription, sub_id)
        if not sub:
            raise HTTPException(status_code=404)
        sub.auto_scrape = not sub.auto_scrape
        session.add(sub)
        session.commit()
        turned_on = sub.auto_scrape

    if turned_on:
        # Kick off background batch scrape for existing unscraped articles
        threading.Thread(target=_batch_scrape_subscription, args=(sub_id,), daemon=True).start()

    with Session(engine) as session:
        sub = session.get(Subscription, sub_id)
        return {"id": sub.id, "auto_scrape": sub.auto_scrape}

@app.delete("/api/subscriptions/{sub_id}")
def api_delete_subscription(sub_id: int):
    with Session(engine) as session:
        sub = session.get(Subscription, sub_id)
        if sub:
            for art in session.exec(select(CachedArticle).where(CachedArticle.feed_id == f"sub_{sub_id}")).all():
                session.delete(art)
            session.delete(sub)
            session.commit()
    return Response(status_code=204)

@app.get("/api/subscriptions/export.opml")
def api_export_subscriptions_opml():
    return export_subscriptions_opml()

@app.post("/api/subscriptions/import_opml")
async def api_import_subscriptions_opml(request: Request, file: UploadFile = File(...)):
    content_bytes = await file.read()
    try:
        content_str = content_bytes.decode("utf-8")
    except:
        content_str = content_bytes.decode("latin-1")
    content_str = re.sub(r'&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+);)', '&amp;', content_str)
    feeds_to_import = []
    try:
        root = ET.fromstring(content_str)
        body = root.find('body')
        if body is not None:
            def parse_outlines_api(elements, current_category=None):
                for elem in elements:
                    if not elem.tag.endswith('outline'):
                        continue
                    url = elem.get('xmlUrl') or elem.get('url')
                    title = elem.get('text') or elem.get('title') or url
                    cat = elem.get('category') or current_category
                    if url:
                        feeds_to_import.append({'url': url, 'title': title, 'category': cat})
                    else:
                        folder_title = elem.get('title') or elem.get('text')
                        parse_outlines_api(list(elem), current_category=folder_title)
            parse_outlines_api(list(body))
        with Session(engine) as session:
            for feed_data in feeds_to_import:
                url = feed_data['url']
                title = feed_data['title']
                cat_name = feed_data['category']
                cat_id = None
                if cat_name:
                    cat = session.exec(select(Category).where(Category.name == cat_name)).first()
                    if not cat:
                        cat = Category(name=cat_name)
                        session.add(cat)
                        session.commit()
                        session.refresh(cat)
                    cat_id = cat.id
                if not session.exec(select(Subscription).where(Subscription.url == url)).first():
                    session.add(Subscription(url=url, title=title, category_id=cat_id))
            session.commit()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error parsing OPML: {str(e)}")
    from threading import Thread
    Thread(target=sync_all_feeds).start()
    return {"imported": len(feeds_to_import)}


# --- Articles ---

@app.get("/api/articles")
def api_get_articles(category_id: str = "all", feed_id: str = None, limit: int = 200):
    with Session(engine) as session:
        settings = get_settings(session)
        read_links = {r.item_link for r in session.exec(select(ReadItem)).all()}
        fav_links = {f.item_link for f in session.exec(select(FavoriteItem).where(FavoriteItem.unfavorited_at == None)).all()}
        # Build auto_scrape lookup for subscriptions
        sub_auto_scrape = {
            f"sub_{s.id}": s.auto_scrape
            for s in session.exec(select(Subscription)).all()
        }
        effective_limit = min(limit, settings.pwa_offline_limit)
        query = select(CachedArticle).order_by(CachedArticle.published.desc()).limit(effective_limit)
        if feed_id:
            query = query.where(CachedArticle.feed_id == feed_id)
        elif category_id == "favorites":
            if not fav_links:
                return []
            query = query.where(CachedArticle.link.in_(list(fav_links)))
        elif category_id == "none":
            query = query.where(CachedArticle.category_id == None)
        elif category_id != "all":
            query = query.where(CachedArticle.category_id == int(category_id))
        db_articles = session.exec(query).all()
        result = []
        for a in db_articles:
            art_dict = a.model_dump(exclude={"scraped_content"})
            art_dict['is_read'] = a.link in read_links
            art_dict['is_favorited'] = a.link in fav_links
            dt = datetime.datetime.fromtimestamp(a.published)
            art_dict['published_str'] = dt.strftime("%b %d, %H:%M")
            art_dict['auto_scrape'] = sub_auto_scrape.get(a.feed_id, False)
            art_dict['has_scraped_content'] = a.scraped_content is not None
            result.append(art_dict)
        return result

@app.post("/api/articles/mark_read")
async def api_mark_read(request: Request):
    data = await request.json()
    url = data.get("url", "").strip()
    if url:
        with Session(engine) as session:
            if not session.exec(select(ReadItem).where(ReadItem.item_link == url)).first():
                session.add(ReadItem(item_link=url))
                session.commit()
    return Response(status_code=204)

@app.post("/api/articles/mark_read_bulk")
async def api_mark_read_bulk(request: Request):
    data = await request.json()
    url_list = [u.strip() for u in data.get("urls", []) if u.strip()]
    if url_list:
        with Session(engine) as session:
            existing = {r.item_link for r in session.exec(select(ReadItem).where(ReadItem.item_link.in_(url_list))).all()}
            new_reads = [ReadItem(item_link=u) for u in url_list if u not in existing]
            if new_reads:
                session.add_all(new_reads)
                session.commit()
    return Response(status_code=204)

@app.post("/api/articles/mark_unread")
async def api_mark_unread(request: Request):
    data = await request.json()
    url = data.get("url", "").strip()
    if url:
        with Session(engine) as session:
            item = session.exec(select(ReadItem).where(ReadItem.item_link == url)).first()
            if item:
                session.delete(item)
                session.commit()
    return Response(status_code=204)

@app.post("/api/articles/mark_unread_bulk")
async def api_mark_unread_bulk(request: Request):
    data = await request.json()
    url_list = [u.strip() for u in data.get("urls", []) if u.strip()]
    if url_list:
        with Session(engine) as session:
            items = session.exec(select(ReadItem).where(ReadItem.item_link.in_(url_list))).all()
            for item in items:
                session.delete(item)
            session.commit()
    return Response(status_code=204)

@app.post("/api/articles/favorite")
async def api_favorite_article(request: Request):
    data = await request.json()
    url = data.get("url", "").strip()
    if url:
        with Session(engine) as session:
            existing = session.exec(select(FavoriteItem).where(FavoriteItem.item_link == url)).first()
            if existing:
                existing.unfavorited_at = None
                existing.favorited_at = datetime.datetime.now()
                session.add(existing)
            else:
                session.add(FavoriteItem(item_link=url))
            # Mark as unread immediately upon favoriting
            read_item = session.exec(select(ReadItem).where(ReadItem.item_link == url)).first()
            if read_item:
                session.delete(read_item)
            session.commit()
    return Response(status_code=204)

@app.post("/api/articles/unfavorite")
async def api_unfavorite_article(request: Request):
    data = await request.json()
    url = data.get("url", "").strip()
    if url:
        with Session(engine) as session:
            fav = session.exec(select(FavoriteItem).where(FavoriteItem.item_link == url)).first()
            if fav:
                fav.unfavorited_at = datetime.datetime.now()
                session.add(fav)
                session.commit()
    return Response(status_code=204)

@app.post("/api/articles/summarize")
async def api_summarize_article(request: Request):
    data = await request.json()
    text = data.get("text", "")
    if not text or len(text.strip()) < 10:
        raise HTTPException(status_code=400, detail="Not enough text")
    limit = 25000
    if len(text) > limit:
        text = text[:limit] + "... [Text Truncated]"
    with Session(engine) as session:
        settings = get_settings(session)
    system_prompt = (
        "You are an expert AI reading assistant. Provide a concise, highly insightful summary of the provided text. "
        "Highlight the main points and key takeaways. Format your response in clean HTML, using <p>, <ul>, <li>, "
        "and <strong> tags to make it easy to scan. Do not include markdown code block syntax (like ```html)."
    )
    try:
        summary_html = call_llm(settings, f"Summarize this text:\n\n{text}", system_prompt)
        summary_html = summary_html.replace("```html", "").replace("```", "").strip()
        return {"summary": summary_html}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/articles/summarize_bulk")
async def api_summarize_bulk(request: Request):
    data = await request.json()
    url_list = [u.strip() for u in data.get("urls", []) if u.strip()]
    scrape_before = data.get("scrape", False)
    if not url_list:
        raise HTTPException(status_code=400, detail="No articles selected")
    max_selected = 10
    if len(url_list) > max_selected:
        raise HTTPException(status_code=400, detail=f"Select up to {max_selected} articles")
    per_article_limit = 7000
    overall_limit = 25000
    with Session(engine) as session:
        settings = get_settings(session)
        cached_by_link = {a.link: a for a in session.exec(select(CachedArticle).where(CachedArticle.link.in_(url_list))).all()}
    article_chunks = []
    remaining = overall_limit
    for idx, link in enumerate(url_list, start=1):
        cached = cached_by_link.get(link)
        title = (cached.title if cached else None) or f"Article {idx}"
        try:
            if scrape_before:
                content_html = scrape_article_html(link)
                text = html_to_plain_text(content_html)
            else:
                if not cached:
                    continue
                text = html_to_plain_text(cached.display_body)
        except Exception as e:
            if cached:
                text = html_to_plain_text(cached.display_body)
            else:
                continue
        text = truncate_text(text, per_article_limit).strip()
        if len(text) < 20:
            continue
        chunk = f"Article {idx}: {title}\nURL: {link}\n\n{text}"
        if len(chunk) > remaining:
            chunk = truncate_text(chunk, remaining).strip()
        article_chunks.append(chunk)
        remaining -= len(chunk)
        if remaining <= 0:
            break
    if not article_chunks:
        raise HTTPException(status_code=400, detail="Could not extract text from selected articles")
    combined_text = truncate_text("\n\n---\n\n".join(article_chunks), overall_limit)
    system_prompt = (
        "You are an expert AI reading assistant. You will be given multiple articles. "
        "Create a single combined summary. Include: (1) a short combined overview of key themes, "
        "(2) a per-article set of key takeaways, and (3) any cross-article connections or notable differences. "
        "Format your response in clean HTML using <p>, <ul>, <li>, and <strong> tags. "
        "Do not include markdown code block syntax (like ```html)."
    )
    try:
        summary_html = call_llm(settings, f"Summarize these articles together:\n\n{combined_text}", system_prompt)
        summary_html = summary_html.replace("```html", "").replace("```", "").strip()
        return {"summary": summary_html}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

_SCRAPE_COOLDOWN_SECONDS = 5.0

@app.post("/api/reader/fetch_content")
async def api_fetch_content(request: Request):
    data = await request.json()
    url = data.get("url", "")
    try:
        # Check for cached scraped content first
        with Session(engine) as session:
            article = session.exec(select(CachedArticle).where(CachedArticle.link == url)).first()
            if article and article.scraped_content:
                logger.info(f"[Reader] Using cached scraped content for: {url}")
                return {"html": article.scraped_content}

        # Enforce a per-URL cooldown to avoid hammering the same origin repeatedly
        now = time.time()
        last = _scrape_last_fetched.get(url, 0)
        if now - last < _SCRAPE_COOLDOWN_SECONDS:
            raise HTTPException(status_code=429, detail="Please wait before re-fetching the same article.")
        _scrape_last_fetched[url] = now

        # Not cached — scrape and save
        content = scrape_article_html(url)
        with Session(engine) as session:
            article = session.exec(select(CachedArticle).where(CachedArticle.link == url)).first()
            if article and not article.scraped_content:
                article.scraped_content = content
                session.add(article)
                session.commit()
        return {"html": content}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

@app.post("/api/reader/force_sync")
def api_force_sync():
    from threading import Thread
    Thread(target=sync_all_feeds).start()
    return {"ok": True}


# --- Feed-level operations ---

@app.post("/api/feeds/{feed_id}/mark_read")
def api_mark_feed_read(feed_id: str):
    with Session(engine) as session:
        read_links = {r.item_link for r in session.exec(select(ReadItem)).all()}
        articles = session.exec(select(CachedArticle).where(CachedArticle.feed_id == feed_id)).all()
        new_reads = [ReadItem(item_link=a.link) for a in articles if a.link not in read_links]
        if new_reads:
            session.add_all(new_reads)
            session.commit()
    return Response(status_code=204)

@app.post("/api/feeds/{feed_id}/toggle_scrape")
def api_toggle_feed_scrape(feed_id: int):
    with Session(engine) as session:
        feed = session.get(Feed, feed_id)
        if not feed:
            raise HTTPException(status_code=404)
        feed.auto_scrape = not feed.auto_scrape
        session.add(feed)
        session.commit()
        return {"id": feed.id, "auto_scrape": feed.auto_scrape}

@app.delete("/api/feeds/{feed_id}")
def api_delete_feed(feed_id: int):
    with Session(engine) as session:
        feed = session.get(Feed, feed_id)
        if feed:
            session.delete(feed)
            session.commit()
    return Response(status_code=204)


# --- Collections ---

@app.get("/api/collections")
def api_list_collections():
    with Session(engine) as session:
        collections = session.exec(select(Collection)).all()
        result = []
        for col in collections:
            status_text = "Pending"
            status_type = "pending"
            if col.is_generating:
                status_text = "Generating..."
                status_type = "generating"
            elif col.last_run:
                status_text = col.last_run.strftime('%d %b %H:%M')
                status_type = "done"
            kw_list = [k.strip() for k in (col.focus_keywords or "").split(",") if k.strip()]
            result.append({
                "id": col.id,
                "name": col.name,
                "slug": col.slug,
                "schedule_time": col.schedule_time,
                "last_run": col.last_run.isoformat() if col.last_run else None,
                "is_generating": col.is_generating,
                "is_active": col.is_active,
                "category_id": col.category_id,
                "focus_keywords": col.focus_keywords,
                "keywords_list": kw_list,
                "context_length": col.context_length,
                "filter_max_articles": col.filter_max_articles,
                "filter_age": col.filter_age,
                "max_articles_per_topic": col.max_articles_per_topic,
                "rag_top_k": col.rag_top_k,
                "rag_min_similarity": col.rag_min_similarity,
                "rag_eviction_days": col.rag_eviction_days,
                "hdbscan_min_cluster_size": col.hdbscan_min_cluster_size,
                "hdbscan_min_samples": col.hdbscan_min_samples,
                "hdbscan_cluster_selection_epsilon": col.hdbscan_cluster_selection_epsilon,
                "hdbscan_cluster_selection_method": col.hdbscan_cluster_selection_method,
                "system_prompt": col.system_prompt,
                "status_text": status_text,
                "status_type": status_type,
            })
        return result

@app.get("/api/collections/{cid}")
def api_get_collection(cid: int):
    with Session(engine) as session:
        col = session.get(Collection, cid)
        if not col:
            raise HTTPException(status_code=404)
        feeds = [{"id": f.id, "url": f.url, "auto_scrape": f.auto_scrape} for f in col.feeds]
        return {
            "id": col.id, "name": col.name, "slug": col.slug,
            "schedule_time": col.schedule_time,
            "last_run": col.last_run.isoformat() if col.last_run else None,
            "is_generating": col.is_generating, "is_active": col.is_active,
            "category_id": col.category_id, "focus_keywords": col.focus_keywords,
            "context_length": col.context_length, "filter_max_articles": col.filter_max_articles,
            "filter_age": col.filter_age, "max_articles_per_topic": col.max_articles_per_topic,
            "rag_top_k": col.rag_top_k, "rag_min_similarity": col.rag_min_similarity,
            "rag_eviction_days": col.rag_eviction_days,
            "hdbscan_min_cluster_size": col.hdbscan_min_cluster_size,
            "hdbscan_min_samples": col.hdbscan_min_samples,
            "hdbscan_cluster_selection_epsilon": col.hdbscan_cluster_selection_epsilon,
            "hdbscan_cluster_selection_method": col.hdbscan_cluster_selection_method,
            "system_prompt": col.system_prompt,
            "feeds": feeds,
        }

@app.post("/api/collections")
async def api_create_collection(request: Request):
    data = await request.json()
    name = data.get("name", "").strip()
    slug = _sanitize_slug(data.get("slug", "").strip())
    category_id_raw = data.get("category_id")
    cat_id = int(category_id_raw) if category_id_raw and str(category_id_raw).isdigit() else None
    if not name or not slug:
        raise HTTPException(status_code=400, detail="Name and slug required")
    with Session(engine) as session:
        if session.exec(select(Collection).where(Collection.slug == slug)).first():
            raise HTTPException(status_code=400, detail="Slug already exists")
        g = get_settings(session)
        col = Collection(
            name=name, slug=slug, schedule_time=g.default_schedule,
            context_length=g.default_context_length, filter_max_articles=g.default_filter_max,
            filter_age=g.default_filter_age, system_prompt=g.default_system_prompt,
            category_id=cat_id, focus_keywords=g.default_focus_keywords or "",
            hdbscan_min_cluster_size=g.default_hdbscan_min_cluster_size,
            hdbscan_min_samples=g.default_hdbscan_min_samples,
            hdbscan_cluster_selection_epsilon=g.default_hdbscan_cluster_selection_epsilon,
            hdbscan_cluster_selection_method=g.default_hdbscan_cluster_selection_method,
        )
        session.add(col)
        session.commit()
        session.refresh(col)
        return {"id": col.id, "name": col.name, "slug": col.slug}

@app.patch("/api/collections/{cid}")
async def api_update_collection(cid: int, request: Request):
    data = await request.json()
    name = data.get("name", "").strip()
    slug = _sanitize_slug(data.get("slug", "").strip())
    category_id_raw = data.get("category_id")
    cat_id = int(category_id_raw) if category_id_raw and str(category_id_raw).isdigit() else None
    if not name or not slug:
        raise HTTPException(status_code=400, detail="Name and slug required")
    with Session(engine) as session:
        col = session.get(Collection, cid)
        if not col:
            raise HTTPException(status_code=404)
        old_slug = col.slug
        if slug != old_slug:
            if session.exec(select(Collection).where(Collection.slug == slug)).first():
                raise HTTPException(status_code=400, detail="Slug taken")
            if os.path.exists(f"/app/data/feeds/{old_slug}.xml"):
                os.rename(f"/app/data/feeds/{old_slug}.xml", f"/app/data/feeds/{slug}.xml")
        col.name = name
        col.slug = slug
        col.category_id = cat_id
        session.add(col)
        session.commit()
        return {"id": col.id, "name": col.name, "slug": col.slug, "category_id": col.category_id}

@app.delete("/api/collections/{cid}")
def api_delete_collection(cid: int):
    with Session(engine) as session:
        col = session.get(Collection, cid)
        if col:
            if os.path.exists(f"/app/data/feeds/{col.slug}.xml"):
                os.remove(f"/app/data/feeds/{col.slug}.xml")
            for feed in col.feeds:
                session.delete(feed)
            session.delete(col)
            session.commit()
    return Response(status_code=204)

@app.get("/api/collections/{cid}/feeds")
def api_get_collection_feeds(cid: int):
    with Session(engine) as session:
        col = session.get(Collection, cid)
        if not col:
            raise HTTPException(status_code=404)
        return [{"id": f.id, "url": f.url, "auto_scrape": f.auto_scrape} for f in col.feeds]

@app.post("/api/collections/{cid}/feeds")
async def api_add_collection_feed(cid: int, request: Request):
    data = await request.json()
    url = data.get("url", "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="URL required")
    auto_scrape = bool(data.get("auto_scrape", False))
    with Session(engine) as session:
        if session.exec(select(Feed).where(Feed.collection_id == cid, Feed.url == url)).first():
            raise HTTPException(status_code=409, detail="Feed already in collection")
        feed = Feed(url=url, collection_id=cid, auto_scrape=auto_scrape)
        session.add(feed)
        session.commit()
        session.refresh(feed)
        return {"id": feed.id, "url": feed.url, "auto_scrape": feed.auto_scrape}

@app.post("/api/collections/{cid}/trigger")
def api_trigger_collection(cid: int):
    from threading import Thread
    t = Thread(target=generate_digest_for_collection, args=(cid,))
    t.start()
    return {"ok": True}

@app.post("/api/collections/trigger_all")
def api_trigger_all_collections():
    from threading import Thread
    def run_all():
        with Session(engine) as session:
            cids = [c.id for c in session.exec(select(Collection).where(Collection.is_active == True)).all()]
        for cid in cids:
            try:
                generate_digest_for_collection(cid)
            except:
                pass
    Thread(target=run_all).start()
    return {"ok": True}

@app.post("/api/collections/{cid}/update_settings")
async def api_update_collection_settings(cid: int, request: Request):
    data = await request.json()
    with Session(engine) as session:
        col = session.get(Collection, cid)
        if not col:
            raise HTTPException(status_code=404)
        col.schedule_time = data.get("schedule_time", col.schedule_time)
        col.context_length = int(data.get("context_length", col.context_length))
        col.filter_max_articles = int(data.get("filter_max_articles", col.filter_max_articles))
        col.filter_age = data.get("filter_age", col.filter_age)
        col.max_articles_per_topic = int(data.get("max_articles_per_topic", col.max_articles_per_topic))
        col.focus_keywords = data.get("focus_keywords", col.focus_keywords)
        col.rag_top_k = int(data.get("rag_top_k", col.rag_top_k))
        col.rag_min_similarity = float(data.get("rag_min_similarity", col.rag_min_similarity))
        col.rag_eviction_days = int(data.get("rag_eviction_days", col.rag_eviction_days))
        _hcs = data.get("hdbscan_min_cluster_size")
        if _hcs is not None:
            try: col.hdbscan_min_cluster_size = max(2, int(_hcs))
            except (ValueError, TypeError): pass
        _hms = data.get("hdbscan_min_samples")
        if _hms is not None:
            try: col.hdbscan_min_samples = max(0, int(_hms))
            except (ValueError, TypeError): pass
        _hep = data.get("hdbscan_cluster_selection_epsilon")
        if _hep is not None:
            try: col.hdbscan_cluster_selection_epsilon = max(0.0, float(_hep))
            except (ValueError, TypeError): pass
        _hmeth = data.get("hdbscan_cluster_selection_method")
        if _hmeth in ("eom", "leaf"):
            col.hdbscan_cluster_selection_method = _hmeth
        session.add(col)
        session.commit()
    return {"ok": True}

@app.post("/api/collections/{cid}/update_prompt")
async def api_update_collection_prompt(cid: int, request: Request):
    data = await request.json()
    system_prompt = data.get("system_prompt", "")
    with Session(engine) as session:
        col = session.get(Collection, cid)
        if not col:
            raise HTTPException(status_code=404)
        col.system_prompt = system_prompt
        session.add(col)
        session.commit()
    return {"ok": True}

@app.post("/api/collections/{cid}/toggle_active")
def api_toggle_collection_active(cid: int):
    with Session(engine) as session:
        col = session.get(Collection, cid)
        if not col:
            raise HTTPException(status_code=404)
        col.is_active = not col.is_active
        session.add(col)
        session.commit()
        return {"id": col.id, "is_active": col.is_active}

@app.get("/api/collections/{cid}/export.opml")
def api_export_collection_opml(cid: int):
    return export_opml(cid)

@app.post("/api/collections/{cid}/import_opml")
async def api_import_collection_opml(cid: int, file: UploadFile = File(...)):
    content_bytes = await file.read()
    try:
        content_str = content_bytes.decode("utf-8")
    except:
        content_str = content_bytes.decode("latin-1")
    content_str = re.sub(r'&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+);)', '&amp;', content_str)
    try:
        root = ET.fromstring(content_str)
        urls = [elem.get('xmlUrl') or elem.get('url') for elem in root.iter() if elem.tag.endswith('outline')]
        urls = [u for u in urls if u]
        with Session(engine) as session:
            for url in urls:
                if not session.exec(select(Feed).where(Feed.collection_id == cid, Feed.url == url)).first():
                    session.add(Feed(url=url, collection_id=cid))
            session.commit()
            col = session.get(Collection, cid)
            feeds = [{"id": f.id, "url": f.url, "auto_scrape": f.auto_scrape} for f in col.feeds]
        return {"imported": len(urls), "feeds": feeds}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# --- Settings ---

@app.get("/api/settings")
def api_get_settings():
    with Session(engine) as session:
        s = get_settings(session)
        return {
            "api_endpoint": s.api_endpoint,
            "api_key_is_set": bool(s.api_key),
            "model_name": s.model_name,
            "default_schedule": s.default_schedule,
            "default_context_length": s.default_context_length,
            "default_filter_max": s.default_filter_max,
            "default_filter_age": s.default_filter_age,
            "default_system_prompt": s.default_system_prompt,
            "default_focus_keywords": s.default_focus_keywords,
            "retention_read_days": s.retention_read_days,
            "retention_unread_days": s.retention_unread_days,
            "reader_font_family": s.reader_font_family,
            "reader_font_size": s.reader_font_size,
            "reader_line_height": s.reader_line_height,
            "reader_font_family_mobile": s.reader_font_family_mobile,
            "reader_font_size_mobile": s.reader_font_size_mobile,
            "reader_line_height_mobile": s.reader_line_height_mobile,
            "pwa_offline_limit": s.pwa_offline_limit,
            "demo_mode": DEMO_MODE,
            "ui_theme": s.ui_theme,
            "ui_accent": s.ui_accent,
            "ui_custom_colors": s.ui_custom_colors,
            "default_hdbscan_min_cluster_size": s.default_hdbscan_min_cluster_size,
            "default_hdbscan_min_samples": s.default_hdbscan_min_samples,
            "default_hdbscan_cluster_selection_epsilon": s.default_hdbscan_cluster_selection_epsilon,
            "default_hdbscan_cluster_selection_method": s.default_hdbscan_cluster_selection_method,
        }

@app.post("/api/settings/update")
async def api_update_settings(request: Request):
    data = await request.json()
    with Session(engine) as session:
        settings = get_settings(session)
        settings.api_type = "openai"
        if not DEMO_MODE:
            if data.get("api_endpoint") is not None:
                settings.api_endpoint = data["api_endpoint"]
            if data.get("api_key"):
                settings.api_key = data["api_key"]
            if data.get("model_name") is not None:
                settings.model_name = clean_model_id(data["model_name"])
        if data.get("ui_theme") in ("default", "light", "sepia", "custom"):
            settings.ui_theme = data["ui_theme"]
        ui_accent = data.get("ui_accent", "")
        if isinstance(ui_accent, str) and re.match(r'^#[0-9a-fA-F]{6}$', ui_accent):
            settings.ui_accent = ui_accent
        ui_custom_colors = data.get("ui_custom_colors", "")
        if isinstance(ui_custom_colors, str) and len(ui_custom_colors) < 1024:
            try:
                import json as _json
                parsed = _json.loads(ui_custom_colors) if ui_custom_colors else {}
                hex_re = re.compile(r'^#[0-9a-fA-F]{6}$')
                allowed_keys = {"background", "surface", "border", "primary", "muted", "fg"}
                if all(k in allowed_keys and isinstance(v, str) and hex_re.match(v) for k, v in parsed.items()):
                    settings.ui_custom_colors = ui_custom_colors
            except Exception:
                pass
        for field in ["default_schedule", "default_filter_age", "default_system_prompt", "default_focus_keywords"]:
            if data.get(field) is not None:
                setattr(settings, field, data[field])
        for css_field in ["reader_font_family", "reader_font_size", "reader_line_height",
                          "reader_font_family_mobile", "reader_font_size_mobile", "reader_line_height_mobile"]:
            if data.get(css_field) is not None:
                setattr(settings, css_field, _sanitize_css_value(data[css_field]))
        for int_field in ["default_context_length", "default_filter_max", "retention_read_days", "retention_unread_days", "pwa_offline_limit",
                          "default_hdbscan_min_cluster_size", "default_hdbscan_min_samples"]:
            if data.get(int_field) is not None:
                try:
                    setattr(settings, int_field, int(data[int_field]))
                except (ValueError, TypeError):
                    pass
        if data.get("default_hdbscan_cluster_selection_epsilon") is not None:
            try:
                settings.default_hdbscan_cluster_selection_epsilon = max(0.0, float(data["default_hdbscan_cluster_selection_epsilon"]))
            except (ValueError, TypeError):
                pass
        if data.get("default_hdbscan_cluster_selection_method") in ("eom", "leaf"):
            settings.default_hdbscan_cluster_selection_method = data["default_hdbscan_cluster_selection_method"]
        session.add(settings)
        session.commit()
    return {"ok": True}

@app.post("/api/settings/test_llm")
async def api_test_llm(request: Request):
    if DEMO_MODE:
        raise HTTPException(status_code=403, detail="Connection testing disabled in demo mode")
    data = await request.json()
    with Session(engine) as session:
        settings = get_settings(session)
        if data.get("api_endpoint"):
            settings.api_endpoint = data["api_endpoint"]
        if data.get("api_key"):
            settings.api_key = data["api_key"]
        if data.get("model_name"):
            settings.model_name = data["model_name"]
    try:
        res = call_llm(settings, "Reply with 'Connection successful!' and nothing else.", "You are a helpful assistant.")
        return {"ok": True, "message": res}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

@app.get("/api/settings/backup")
def api_backup_database():
    return backup_database()

@app.post("/api/settings/restore")
async def api_restore_database(file: UploadFile = File(...)):
    if DEMO_MODE:
        raise HTTPException(status_code=403, detail="Restore disabled in demo mode")
    content = await file.read()
    with open(DB_FILE, "wb") as f:
        f.write(content)
    return {"ok": True, "message": "Database restored. Please restart the container."}

