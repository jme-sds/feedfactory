from fastapi import FastAPI, Request, Form, Depends, HTTPException, UploadFile, File, Header, BackgroundTasks
from fastapi.responses import HTMLResponse, Response, StreamingResponse, FileResponse
from fastapi.templating import Jinja2Templates
from sqlmodel import Session, SQLModel, create_engine, select, or_, and_, Field, Relationship
from sqlalchemy import inspect, text
from apscheduler.schedulers.background import BackgroundScheduler
from contextlib import asynccontextmanager
from typing import Optional, List
from urllib.parse import urljoin
from bs4 import BeautifulSoup
from gradio_client import Client
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
import html
import hashlib
import socket
import ipaddress
from sentence_transformers import SentenceTransformer
from sklearn.cluster import KMeans
import numpy as np



logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("FeedFactory")

DB_FILE = "/app/data/database.db"
DATABASE_URL = f"sqlite:///{DB_FILE}"

# --- UPDATE YOUR INITIAL PROMPT CONSTANT ---
INITIAL_SYSTEM_PROMPT = """You are an expert news editor. You have been given a list of highly related articles about a specific topic.
Your goal is to write a single cohesive digest section for this topic.

Write a HIGH-LEVEL NARRATIVE PARAGRAPH (4-6 sentences) that synthesizes the news. Explain "what is going on" by weaving the facts together. Give the section a catchy, relevant title.

Output valid HTML. Use <h3> for the category title and <p> for the narrative. Do NOT include a list of sources, and do NOT wrap the entire output in html/body tags."""


engine = create_engine(DATABASE_URL)
templates = Jinja2Templates(directory="templates")

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
    # --- NEW: PWA Offline Limit ---
    pwa_offline_limit: int = Field(default=200)
    default_focus_keywords: str = Field(default="")
    scraper_backend: str = Field(default="postlight")
    apify_api_key: Optional[str] = None

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

class Feed(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    url: str
    collection_id: Optional[int] = Field(default=None, foreign_key="collection.id")
    collection: Optional[Collection] = Relationship(back_populates="feeds")
    auto_scrape: bool = Field(default=False)

class Subscription(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    url: str = Field(unique=True)
    title: Optional[str] = None
    category_id: Optional[int] = Field(default=None, foreign_key="category.id")
    added_at: datetime.datetime = Field(default_factory=datetime.datetime.now)

class ReadItem(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    item_link: str = Field(unique=True, index=True)
    read_at: datetime.datetime = Field(default_factory=datetime.datetime.now)

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

# --- Helpers ---
def clean_model_id(raw_id: str) -> str:
    if not raw_id: return ""
    return str(raw_id).replace('\\"', '').strip(' "\'')

def get_settings(session: Session) -> GlobalSettings:
    settings = session.get(GlobalSettings, 1)
    if not settings:
        settings = GlobalSettings(
            id=1, api_key=os.getenv("HF_TOKEN"), api_endpoint="https://router.huggingface.co/v1/chat/completions",
            model_name="Qwen/Qwen2.5-72B-Instruct", default_system_prompt=INITIAL_SYSTEM_PROMPT
        )
        session.add(settings); session.commit(); session.refresh(settings)
    return settings

def fetch_external_feed(url):
    try:
        resp = requests.get(url, headers={"User-Agent": "FeedFactory/1.0"}, timeout=5)
        if resp.status_code == 200: return feedparser.parse(resp.content)
    except: pass
    return None

def parse_date(entry):
    if hasattr(entry, 'published_parsed') and entry.published_parsed: return time.mktime(entry.published_parsed)
    if hasattr(entry, 'updated_parsed') and entry.updated_parsed: return time.mktime(entry.updated_parsed)
    return time.time()

# --- BACKGROUND SYNC AND CLEANUP ---
def sync_all_feeds():
    logger.info("Starting background feed sync...")
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
                except Exception as e: logger.error(f"Sync error (Collection {col.name}): {e}")

        subs = session.exec(select(Subscription)).all()
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            future_to_sub = {executor.submit(fetch_external_feed, sub.url): sub for sub in subs}
            for future in concurrent.futures.as_completed(future_to_sub):
                sub = future_to_sub[future]
                try:
                    feed = future.result()
                    if feed:
                        title = sub.title or feed.feed.get('title', 'Unknown Feed')
                        for entry in feed.entries:
                            if not session.exec(select(CachedArticle).where(CachedArticle.link == entry.link)).first():
                                body = entry.content[0].value if 'content' in entry and entry.content else entry.get('summary', '') or entry.get('description', '')
                                session.add(CachedArticle(
                                    ui_id=str(hash(entry.link)), feed_id=f"sub_{sub.id}", link=entry.link, title=entry.title, display_body=body,
                                    published=parse_date(entry), source_title=title, source_color="#4CAF50",
                                    is_generated=False, category_id=sub.category_id
                                ))
                except Exception as e: logger.error(f"Sync error (Sub {sub.url}): {e}")
        session.commit()
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
        deleted = 0
        for article in articles:
            is_read = article.link in read_links
            if (is_read and article.published < read_cutoff) or (not is_read and article.published < unread_cutoff):
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
    
    try:
        response = requests.post(settings.api_endpoint, headers=headers, json=payload, timeout=180)
        if not response.ok:
            logger.error(f"LLM Rejected Payload. Status: {response.status_code}")
            logger.error(f"LLM Error Body: {response.text}")
            
        response.raise_for_status()
        data = response.json()
        return data['choices'][0]['message']['content']
        
    except Exception as e:
        logger.error(f"LLM Call Failed: {e}")
        raise e



def render_feed_rows(collection_id: int, feeds: list[Feed]):
    html_parts = []
    for feed in feeds:
        html_parts.append(f'<div class="feed-row"><span class="feed-url" title="{feed.url}">{feed.url}</span><button class="icon-btn danger" hx-delete="/feeds/{feed.id}" hx-confirm="Remove feed?" hx-target="#feed-list-{collection_id}"><svg class="icon"><use href="#icon-trash"/></svg></button></div>')
    return "\n".join(html_parts)

def save_rss_file(collection, content_html):
    os.makedirs("/app/data/feeds", exist_ok=True)
    filename = f"/app/data/feeds/{collection.slug}.xml"
    now_str = datetime.datetime.now().strftime("%a, %d %b %Y %H:%M:%S GMT")
    item_title = f"{collection.name}: Digest {datetime.datetime.now().strftime('%d %b')}"
    
    # Generate a unique ID for this specific digest run
    unique_id = f"{collection.slug}-{int(time.time())}"
    
    # Notice the <link> tag inside the <item> now uses the unique_id
    xml = f"""<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
    <channel>
        <title>{collection.name} Digest</title>
        <link>http://localhost</link>
        <description>AI Generated Digest</description>
        <lastBuildDate>{now_str}</lastBuildDate>
        <item>
            <title>{item_title}</title>
            <link>http://localhost/digest/{unique_id}</link>
            <description><![CDATA[{content_html}]]></description>
            <pubDate>{now_str}</pubDate>
            <guid>{unique_id}</guid>
        </item>
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
                # Note: We now pass the feed object itself into the dictionary, not just the URL
                future_to_feed = {executor.submit(fetch_external_feed, feed.url): feed for feed in collection.feeds}
                
                for future in concurrent.futures.as_completed(future_to_feed):
                    feed = future_to_feed[future]
                    try:
                        parsed = future.result()
                        if parsed:
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

                                # --- NEW: Postlight Auto-Scrape ---
                                text_content = entry.get('summary', '') or entry.get('description', '') or ''
                                
                                if feed.auto_scrape and entry.link:
                                    try:
                                        logger.info(f"[Auto-Scrape] Fetching full content for: {entry.title}")
                                        parser_url = f"http://parser:3000/parser?url={entry.link}"
                                        resp = requests.get(parser_url, timeout=10)
                                        if resp.ok:
                                            p_data = resp.json()
                                            if p_data.get('content'):
                                                # Overwrite the weak summary with the full article text!
                                                text_content = p_data['content']
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

            # --- Pass the new topic limit setting to the clusterer ---
            article_clusters = cluster_articles(all_entries, num_clusters=5, max_per_topic=collection.max_articles_per_topic)












            # Safeguard: Override legacy prompts (both the "3-5 categories" one AND the "bulleted list of links" one)
            active_prompt = collection.system_prompt
            if active_prompt and ("3-5 logical categories" in active_prompt or "provide a bulleted list" in active_prompt):
                active_prompt = INITIAL_SYSTEM_PROMPT

            logger.info(f"[Digest] 🧠 Firing {len(article_clusters)} parallel LLM calls for each topic cluster...")
            
            # Define the worker function for the LLM + Python HTML Builder
            def process_cluster(cluster):
                # 1. Prepare the text context for the LLM
                context = "\n".join([a["formatted"] for a in cluster])
                user_msg = f"Here are the related articles for this topic:\n\n{context}\n\nWrite this section of the digest."
                
                # 2. Get the narrative paragraph from the LLM
                llm_narrative = call_llm(settings, user_msg, active_prompt)
                
                # 3. Programmatically build the perfectly formatted Sources HTML
                sources_html = "\n<h5 style='margin-top: 1rem; margin-bottom: 0.5rem; color: #888;'>Sources:</h5>\n<ul style='font-size: 0.9rem; margin-bottom: 1.5rem;'>\n"
                
                # We use html.escape on the title just in case the article title has weird characters like < or >
                for article in cluster:
                    safe_title = html.escape(article['title'])
                    safe_link = article['link']
                    sources_html += f"    <li style='margin-bottom: 0.25rem;'><a href='{safe_link}' target='_blank' style='color: #1095c1; text-decoration: none;'>{safe_title}</a></li>\n"
                
                sources_html += "</ul>\n"
                
                # 4. Stitch the LLM narrative and the Python Sources list together
                return f"{llm_narrative}\n{sources_html}"

            # Fire off the LLM calls simultaneously
            cluster_html_results = []
            with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
                # Map preserves the order of the clusters
                results = list(executor.map(process_cluster, article_clusters))
                for res in results:
                    cluster_html_results.append(res)

            # Stitch the 5 perfectly written sections together
            final_html = "\n<br><hr style='border-color: #333;'><br>\n".join(cluster_html_results)



            logger.info("[Digest] ✅ Multi-Topic LLM generation successful! Saving RSS digest...")
            save_rss_file(collection, final_html)

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

# Lazy-load the model so it doesn't slow down FastAPI startup
_embedding_model = None

def get_embedding_model():
    global _embedding_model
    if _embedding_model is None:
        logger.info("[Clustering] Loading MiniLM embedding model into memory...")
        _embedding_model = SentenceTransformer('all-MiniLM-L6-v2')
    return _embedding_model


def cluster_articles(articles: List[dict], num_clusters: int = 5, max_per_topic: int = 5) -> List[List[dict]]:
    """Groups articles and drops outliers by measuring distance to the semantic center."""
    n_clusters = min(num_clusters, len(articles))
    if n_clusters <= 1:
        return [articles[:max_per_topic]]

    logger.info(f"[Clustering] Embedding {len(articles)} articles for semantic analysis...")
    model = get_embedding_model()
    texts_to_embed = [f"{a['title']}. {a['text']}" for a in articles]
    embeddings = model.encode(texts_to_embed)

    logger.info(f"[Clustering] Grouping into {n_clusters} topics and filtering outliers...")
    kmeans = KMeans(n_clusters=n_clusters, random_state=42, n_init="auto")
    
    # Fit the model AND get the mathematical distances to the cluster centers
    kmeans.fit(embeddings)
    labels = kmeans.labels_
    distances = kmeans.transform(embeddings)

    clusters = {i: [] for i in range(n_clusters)}
    for idx, label in enumerate(labels):
        # Grab the exact distance from this article to its assigned topic's core
        dist_to_center = distances[idx, label]
        clusters[label].append({"article": articles[idx], "dist": dist_to_center})

    final_clusters = []
    for c_id, items in clusters.items():
        if not items: continue
        # Sort by distance (closest to the core topic first)
        items.sort(key=lambda x: x["dist"])
        # Slice off the outliers based on our max_per_topic setting
        sliced_articles = [x["article"] for x in items[:max_per_topic]]
        final_clusters.append(sliced_articles)

    return final_clusters








@asynccontextmanager
async def lifespan(app: FastAPI):
    SQLModel.metadata.create_all(engine)
    upgrade_db_schema(engine)
    
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

        env_apify_key = os.environ.get("APIFY_API_KEY")
        if env_apify_key and settings.apify_api_key != env_apify_key:
            settings.apify_api_key = env_apify_key
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
    scheduler = BackgroundScheduler()
    scheduler.add_job(scheduled_checker, 'interval', minutes=15)
    scheduler.add_job(sync_all_feeds, 'interval', minutes=15)
    scheduler.add_job(cleanup_old_articles, 'interval', hours=1)
    scheduler.start()
    
    from threading import Thread
    Thread(target=sync_all_feeds).start()
    Thread(target=cleanup_old_articles).start()
    yield
    scheduler.shutdown()

app = FastAPI(lifespan=lifespan)
from fastapi.staticfiles import StaticFiles

app.mount("/static", StaticFiles(directory="static"), name="static")

# ==========================================
#               READER ROUTES
# ==========================================

@app.post("/feeds/{feed_id}/toggle_scrape")
def toggle_scrape(feed_id: int):
    with Session(engine) as session:
        feed = session.get(Feed, feed_id)
        if feed:
            feed.auto_scrape = not feed.auto_scrape
            session.add(feed)
            session.commit()
    return "Toggled"




@app.get("/", response_class=HTMLResponse)
def read_home(request: Request):
    with Session(engine) as session:
        categories = session.exec(select(Category)).all()
        settings = get_settings(session)
        collections = session.exec(select(Collection)).all()
        return templates.TemplateResponse("reader.html", {"request": request, "categories": categories, "settings": settings, "collections": collections})

@app.get("/reader/categories", response_class=HTMLResponse)
def get_categories(request: Request):
    with Session(engine) as session:
        # Guarantee categories are alphabetized initially
        categories = session.exec(select(Category).order_by(Category.name)).all()
        
        unread_counts = {cat.id: 0 for cat in categories}
        unread_counts[None] = 0
        
        # NEW: Track newest article timestamp per category
        latest_timestamps = {cat.id: 0 for cat in categories}
        latest_timestamps[None] = 0
        latest_timestamps["all"] = 0
        
        read_links = {r.item_link for r in session.exec(select(ReadItem)).all()}
        articles = session.exec(select(CachedArticle)).all()
        total_unread = 0
        
        for article in articles:
            cat_id = article.category_id
            pub = article.published
            
            # Record the highest (newest) timestamp per category
            if cat_id in latest_timestamps and pub > latest_timestamps[cat_id]:
                latest_timestamps[cat_id] = pub
            elif cat_id is None and pub > latest_timestamps[None]:
                latest_timestamps[None] = pub
                
            if pub > latest_timestamps["all"]:
                latest_timestamps["all"] = pub

            if article.link not in read_links:
                total_unread += 1
                if cat_id in unread_counts: unread_counts[cat_id] += 1
                elif cat_id is None: unread_counts[None] += 1

        return templates.TemplateResponse("partials/category_tiles.html", {
            "request": request, 
            "categories": categories, 
            "unread_counts": unread_counts, 
            "total_unread": total_unread,
            "latest_timestamps": latest_timestamps # PASS TO TEMPLATE
        })



@app.get("/reader/category/{category_id}/feeds", response_class=HTMLResponse)
def get_feed_tiles(request: Request, category_id: str):
    with Session(engine) as session:
        cat_name = "All Feeds"
        if category_id not in ["all", "none"]:
            cat = session.get(Category, int(category_id))
            if cat: cat_name = cat.name
        elif category_id == "none": cat_name = "Uncategorized"

        read_links = {r.item_link for r in session.exec(select(ReadItem)).all()}
        feeds_list = []
        
        cols = session.exec(select(Collection)).all()
        for col in cols:
            if category_id == "all" or (category_id == "none" and col.category_id is None) or (category_id not in ["all", "none"] and str(col.category_id) == category_id):
                # NEW: Clean and parse the keywords into a list
                raw_kw = col.focus_keywords or ""
                kw_list = [k.strip() for k in raw_kw.split(",") if k.strip()]
                feeds_list.append({"id": f"col_{col.id}", "name": f"✨ {col.name}", "type": "collection", "db_id": col.id, "url": "", "keywords": kw_list})
                
        subs = session.exec(select(Subscription)).all()
        for sub in subs:
            if category_id == "all" or (category_id == "none" and sub.category_id is None) or (category_id not in ["all", "none"] and str(sub.category_id) == category_id):
                feeds_list.append({"id": f"sub_{sub.id}", "name": sub.title or sub.url, "type": "subscription", "db_id": sub.id, "url": sub.url, "keywords": []})
                
        unread_counts = {f["id"]: 0 for f in feeds_list}
        total_unread = 0
        
        articles = session.exec(select(CachedArticle)).all()
        for article in articles:
            if article.link not in read_links:
                if article.feed_id in unread_counts:
                    unread_counts[article.feed_id] += 1
                if category_id == "all" or str(article.category_id) == category_id or (category_id == "none" and article.category_id is None):
                    total_unread += 1

        return templates.TemplateResponse("partials/feed_tiles.html", {
            "request": request, "feeds": feeds_list, "unread_counts": unread_counts,
            "category_id": category_id, "category_name": cat_name, "total_unread": total_unread
        })
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


def _is_instagram_url(url: str) -> bool:
    return bool(re.search(r'instagram\.com', url, re.IGNORECASE))


def scrape_article_html_apify(url: str, apify_api_key: str) -> str:
    """
    Scrape an article or Instagram post via Apify and return sanitized HTML.
    - Instagram URLs: uses apify/instagram-scraper actor to fetch post data
    - All other URLs: uses apify/article-extractor-smart actor
    """
    if not apify_api_key:
        raise RuntimeError("Apify API key not configured. Set it in Settings or via APIFY_API_KEY env var.")

    apify_base = "https://api.apify.com/v2"

    if _is_instagram_url(url):
        # --- Instagram scraper ---
        actor_id = "apify~instagram-scraper"
        run_input = {
            "directUrls": [url],
            "resultsType": "posts",
            "resultsLimit": 1,
        }
        run_resp = requests.post(
            f"{apify_base}/acts/{actor_id}/run-sync-get-dataset-items",
            params={"token": apify_api_key, "timeout": 60, "memory": 256},
            json=run_input,
            timeout=90,
        )
        run_resp.raise_for_status()
        items = run_resp.json()
        if not items:
            raise RuntimeError("Apify Instagram scraper returned no results for this URL.")

        post = items[0]
        caption = post.get("caption") or post.get("alt") or ""
        owner = post.get("ownerUsername") or post.get("ownerId") or ""
        timestamp = post.get("timestamp") or post.get("taken_at_timestamp") or ""
        images: list = []

        def _clean_apify_url(u) -> str:
            """Strip stray quote chars Apify sometimes includes in URL strings."""
            if not isinstance(u, str):
                return ""
            return u.strip().strip('"').strip("'").strip()

        # Collect images/video thumbnails
        raw_display = _clean_apify_url(post.get("displayUrl"))
        if raw_display:
            images.append(raw_display)
        for sidecar in (post.get("childPosts") or post.get("sidecarImages") or []):
            img_url = _clean_apify_url(sidecar.get("displayUrl") or sidecar.get("url"))
            if img_url:
                images.append(img_url)

        # Build HTML
        parts = []
        if owner:
            parts.append(f'<p style="color:#888; font-size:0.9rem; margin-bottom:0.5rem;">@{html.escape(owner)}</p>')
        if timestamp:
            parts.append(f'<p style="color:#666; font-size:0.85rem; margin-bottom:1rem;">{html.escape(str(timestamp))}</p>')
        for img_url in images:
            if img_url.startswith(("http://", "https://")):
                # Instagram CDN images are signed with session cookies — render directly,
                # do NOT proxy them through the server (proxy would get 403 from Instagram).
                parts.append(
                    f'<img src="{html.escape(img_url)}" loading="lazy" crossorigin="anonymous" '
                    f'style="max-width:100%;height:auto;border-radius:8px;margin:1rem auto;display:block;box-shadow:0 4px 12px rgba(0,0,0,0.3);" '
                    f'onerror="this.style.display=\'none\'" alt="Instagram post image"/>'
                )
        if caption:
            escaped = html.escape(caption).replace("\n", "<br>")
            parts.append(f'<p style="margin-top:1.5rem;line-height:1.7;">{escaped}</p>')

        return "\n".join(parts) if parts else "<p>No content found in this Instagram post.</p>"

    else:
        # --- General article extractor ---
        # Uses lukaskrivka/article-extractor-smart — a well-known community actor
        actor_id = "lukaskrivka~article-extractor-smart"
        run_input = {"startUrls": [{"url": url}], "proxyConfiguration": {"useApifyProxy": True}}
        run_resp = requests.post(
            f"{apify_base}/acts/{actor_id}/run-sync-get-dataset-items",
            params={"token": apify_api_key, "timeout": 60, "memory": 256},
            json=run_input,
            timeout=90,
        )
        run_resp.raise_for_status()
        items = run_resp.json()
        if not items:
            raise RuntimeError("Apify article extractor returned no results for this URL.")

        article = items[0]
        # Actor returns: text (plain), loadedContent/content (HTML), topImage/image
        raw_html = (article.get("loadedContent") or article.get("content")
                    or article.get("text") or "")
        if not raw_html:
            raise RuntimeError("Apify article extractor could not extract content from this page.")

        # Lead image — check multiple field names the actor may use
        header_image_html = ""
        lead_image = (article.get("topImage") or article.get("image")
                      or article.get("featuredImage") or "")
        if lead_image and isinstance(lead_image, str) and lead_image.startswith(("http://", "https://")):
            proxied_lead = "/reader/image_proxy?url=" + quote(lead_image, safe="")
            header_image_html = (
                f'<img src="{proxied_lead}" '
                f'style="max-width:100%;height:auto;border-radius:8px;'
                f'margin-bottom:1.5rem;display:block;box-shadow:0 4px 12px rgba(0,0,0,0.3);" '
                f'onerror="this.style.display=\'none\'" alt="Header Image"/>\n'
            )

        # If text is plain or markdown-ish, wrap in a <p>
        if not raw_html.strip().startswith("<"):
            raw_html = "<p>" + raw_html.replace("\n\n", "</p><p>").replace("\n", "<br>") + "</p>"

        soup = BeautifulSoup(raw_html, 'html.parser')
        for tag in soup.find_all(['script', 'style', 'iframe', 'noscript']):
            tag.decompose()
        for picture in soup.find_all('picture'):
            img = picture.find('img')
            if img:
                picture.replace_with(img)
            else:
                picture.decompose()
        for source in soup.find_all('source'):
            source.decompose()
        for a in soup.find_all('a'):
            href = extract_real_url(a.get('href'), url)
            if href:
                a['href'] = href
            a['target'] = '_blank'
            a['style'] = 'color:#1095c1;text-decoration:none;'
        for img in soup.find_all('img'):
            src = extract_real_url(img.get('src'), url)
            if src and src.startswith(("http://", "https://")):
                img['src'] = "/reader/image_proxy?url=" + quote(src, safe="")
            elif src and src.startswith("data:"):
                img['src'] = src
            else:
                img.decompose()
                continue
            img['loading'] = 'lazy'
            img['style'] = (
                'max-width:100%;height:auto;border-radius:8px;'
                'margin:1.5rem auto;display:block;box-shadow:0 4px 12px rgba(0,0,0,0.3);'
            )
            img['onerror'] = "this.style.display='none'"
            for attr in ['class', 'width', 'height', 'srcset', 'sizes', 'referrerpolicy']:
                if attr in img.attrs:
                    del img[attr]

        return header_image_html + str(soup)


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


@app.post("/reader/fetch_content")
def fetch_content(url: str = Form(...)):
    try:
        with Session(engine) as session:
            settings = get_settings(session)
        if settings.scraper_backend == "apify":
            return scrape_article_html_apify(url, settings.apify_api_key or "")
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
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
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





@app.get("/reader/stream", response_class=HTMLResponse)
def reader_stream(request: Request, category_id: str = "all", feed_id: str = None):
    category_name = "All Feeds"
    with Session(engine) as session:
        settings = get_settings(session) # Fetch settings to get the limit
        
        if category_id and category_id not in ["all", "none"]:
            cat = session.get(Category, int(category_id))
            if cat: category_name = cat.name
        elif category_id == "none": category_name = "Uncategorized"
            
        read_links = {r.item_link for r in session.exec(select(ReadItem)).all()}
        
        # Apply the PWA Cache Limit setting here
        query = select(CachedArticle).order_by(CachedArticle.published.desc()).limit(settings.pwa_offline_limit)
        # ... (rest of the function stays exactly the same)
        if feed_id: query = query.where(CachedArticle.feed_id == feed_id)
        else:
            if category_id == "none": query = query.where(CachedArticle.category_id == None)
            elif category_id != "all": query = query.where(CachedArticle.category_id == int(category_id))
            
        db_articles = session.exec(query).all()
        articles = []
        for a in db_articles:
            art_dict = a.model_dump()
            art_dict['is_read'] = a.link in read_links
            dt = datetime.datetime.fromtimestamp(a.published)
            art_dict['published_str'] = dt.strftime("%b %d, %H:%M")
            articles.append(art_dict)

    return templates.TemplateResponse("partials/stream.html", {"request": request, "articles": articles, "category_name": category_name, "category_id": category_id, "feed_id":feed_id})




@app.post("/reader/mark_read")
def mark_read(url: str = Form(...)):
    with Session(engine) as session:
        if not session.exec(select(ReadItem).where(ReadItem.item_link == url)).first():
            session.add(ReadItem(item_link=url)); session.commit()
    return Response(status_code=200)

@app.post("/reader/mark_category_read", response_class=HTMLResponse)
def mark_category_read(request: Request, category_id: str = Form(...)):
    with Session(engine) as session:
        read_links = {r.item_link for r in session.exec(select(ReadItem)).all()}
        new_reads = []
        query = select(CachedArticle)
        if category_id == "none": query = query.where(CachedArticle.category_id == None)
        elif category_id != "all": query = query.where(CachedArticle.category_id == int(category_id))
        articles = session.exec(query).all()
        for a in articles:
            if a.link not in read_links:
                new_reads.append(ReadItem(item_link=a.link))
                read_links.add(a.link)
        if new_reads: session.add_all(new_reads); session.commit()
    return get_category_tiles(request)

@app.post("/reader/mark_feed_read", response_class=HTMLResponse)
def mark_feed_read(request: Request, feed_id: str = Form(...), category_id: str = Form(...)):
    with Session(engine) as session:
        read_links = {r.item_link for r in session.exec(select(ReadItem)).all()}
        new_reads = []
        articles = session.exec(select(CachedArticle).where(CachedArticle.feed_id == feed_id)).all()
        for a in articles:
            if a.link not in read_links:
                new_reads.append(ReadItem(item_link=a.link))
                read_links.add(a.link)
        if new_reads: session.add_all(new_reads); session.commit()
    return get_feed_tiles(request, category_id)

@app.post("/reader/summarize_article", response_class=HTMLResponse)
def summarize_single_article(text: str = Form(...)):
    with Session(engine) as session:
        settings = get_settings(session)
        
        if not text or len(text.strip()) < 10:
            return "<p>Error: Not enough text provided to summarize.</p>"

        # Limit text length to avoid blowing up the context window on massive articles
        limit = 25000 
        if len(text) > limit:
            text = text[:limit] + "... [Text Truncated]"

        system_prompt = (
            "You are an expert AI reading assistant. Provide a concise, highly insightful summary of the provided text. "
            "Highlight the main points and key takeaways. Format your response in clean HTML, using <p>, <ul>, <li>, "
            "and <strong> tags to make it easy to scan. Do not include markdown code block syntax (like ```html)."
        )
        
        try:
            summary_html = call_llm(settings, f"Summarize this text:\n\n{text}", system_prompt)
            # Strip markdown formatting just in case the LLM disobeys the prompt
            summary_html = summary_html.replace("```html", "").replace("```", "").strip()
            return summary_html
        except Exception as e:
            logger.error(f"Single Article Summary Failed: {e}")
            return f"<p style='color: #ff4444;'>Error generating summary: {str(e)}</p>"




@app.post("/reader/mark_read_bulk")
def mark_read_bulk(urls: str = Form(...)):
    # `urls` is a comma-separated list of article links.
    url_list = [u.strip() for u in (urls or "").split(",") if u.strip()]
    if not url_list:
        return Response(status_code=200)

    with Session(engine) as session:
        existing = session.exec(select(ReadItem).where(ReadItem.item_link.in_(url_list))).all()
        existing_set = {x.item_link for x in existing}

        new_reads = [ReadItem(item_link=u) for u in url_list if u not in existing_set]
        if new_reads:
            session.add_all(new_reads)
            session.commit()

    return Response(status_code=200)


@app.post("/reader/summarize_articles", response_class=HTMLResponse)
def summarize_selected_articles(urls: str = Form(...), scrape: str = Form("0")):
    """
    Generate one combined HTML summary for multiple selected articles.
    If `scrape` is enabled, each URL is scraped via the Postlight parser sidecar first.
    """
    url_list = [u.strip() for u in (urls or "").split(",") if u.strip()]
    if not url_list:
        return "<p>Error: No articles selected.</p>"

    scrape_before = str(scrape).strip().lower() in ("1", "true", "yes", "on")

    # Avoid runaway token usage.
    max_selected = 10
    if len(url_list) > max_selected:
        return f"<p style='color: #ff4444;'>Error: Please select up to {max_selected} articles.</p>"

    # Text limits
    per_article_limit = 7000
    overall_limit = 25000

    with Session(engine) as session:
        settings = get_settings(session)

        cached_by_link = {}
        for a in session.exec(select(CachedArticle).where(CachedArticle.link.in_(url_list))).all():
            cached_by_link[a.link] = a

    article_chunks = []
    remaining = overall_limit

    for idx, link in enumerate(url_list, start=1):
        cached = cached_by_link.get(link)
        title = (cached.title if cached else None) or f"Article {idx}"

        try:
            if scrape_before:
                html = scrape_article_html(link)
                text = html_to_plain_text(html)
            else:
                if not cached:
                    continue
                text = html_to_plain_text(cached.display_body)
        except Exception as e:
            logger.error(f"Batch summary scrape failed for {link}: {e}")
            # Fallback to cached snippet if available.
            if cached:
                text = html_to_plain_text(cached.display_body)
            else:
                continue

        text = truncate_text(text, per_article_limit).strip()
        if len(text) < 20:
            continue

        chunk = f"Article {idx}: {title}\nURL: {link}\n\n{text}"

        # Enforce overall cap
        if len(chunk) > remaining:
            chunk = truncate_text(chunk, remaining).strip()

        article_chunks.append(chunk)
        remaining -= len(chunk)
        if remaining <= 0:
            break

    if not article_chunks:
        return "<p style='color: #ff4444;'>Error: Could not extract enough text from the selected articles.</p>"

    combined_text = "\n\n---\n\n".join(article_chunks)
    combined_text = truncate_text(combined_text, overall_limit)

    system_prompt = (
        "You are an expert AI reading assistant. You will be given multiple articles. "
        "Create a single combined summary. Include: (1) a short combined overview of key themes, "
        "(2) a per-article set of key takeaways, and (3) any cross-article connections or notable differences. "
        "Format your response in clean HTML using <p>, <ul>, <li>, and <strong> tags. "
        "Do not include markdown code block syntax (like ```html)."
    )

    try:
        summary_html = call_llm(
            settings,
            f"Summarize these articles together:\n\n{combined_text}",
            system_prompt,
        )
        summary_html = summary_html.replace("```html", "").replace("```", "").strip()
        return summary_html
    except Exception as e:
        logger.error(f"Batch Article Summary Failed: {e}")
        return f"<p style='color: #ff4444;'>Error generating summary: {str(e)}</p>"


@app.delete("/subscriptions/{sub_id}")
def delete_subscription(request: Request, sub_id: int, category_id: str = "all"):
    with Session(engine) as session:
        sub = session.get(Subscription, sub_id)
        if sub:
            arts = session.exec(select(CachedArticle).where(CachedArticle.feed_id == f"sub_{sub_id}")).all()
            for art in arts: session.delete(art)
            session.delete(sub); session.commit()
    return get_feed_tiles(request, category_id)

@app.post("/categories/{cat_id}/rename")
def rename_category(request: Request, cat_id: int, hx_prompt: str = Header(None, alias="HX-Prompt")):
    if hx_prompt and hx_prompt.strip():
        with Session(engine) as session:
            cat = session.get(Category, cat_id)
            if cat:
                cat.name = hx_prompt.strip()
                session.add(cat); session.commit()
    return get_category_tiles(request)

@app.delete("/categories/{cat_id}")
def delete_category(request: Request, cat_id: int):
    with Session(engine) as session:
        cat = session.get(Category, cat_id)
        if cat:
            subs = session.exec(select(Subscription).where(Subscription.category_id == cat_id)).all()
            for sub in subs: sub.category_id = None; session.add(sub)
            cols = session.exec(select(Collection).where(Collection.category_id == cat_id)).all()
            for col in cols: col.category_id = None; session.add(col)
            arts = session.exec(select(CachedArticle).where(CachedArticle.category_id == cat_id)).all()
            for art in arts: art.category_id = None; session.add(art)
            session.delete(cat); session.commit()
    return get_category_tiles(request)

@app.post("/categories/{cat_id}/create_collection")
def create_collection_from_category(cat_id: str):
    with Session(engine) as session:
        if cat_id == "all":
            subs = session.exec(select(Subscription)).all()
            col_name = "All Feeds Digest"
        elif cat_id == "none":
            subs = session.exec(select(Subscription).where(Subscription.category_id == None)).all()
            col_name = "Uncategorized Digest"
        else:
            cat = session.get(Category, int(cat_id))
            if not cat: return Response("Not found", 404)
            subs = session.exec(select(Subscription).where(Subscription.category_id == int(cat_id))).all()
            col_name = f"{cat.name} Digest"
            
        # NEW: Find or create the AI Digest category to use as the destination
        ai_cat = session.exec(select(Category).where(Category.name == "AI Digest")).first()
        if not ai_cat:
            ai_cat = Category(name="AI Digest")
            session.add(ai_cat); session.commit(); session.refresh(ai_cat)
        
        # Override the destination category
        assign_cat = ai_cat.id
        
        # Build URL-safe slug
        slug = re.sub(r'[^a-z0-9]', '-', col_name.lower()) + "-" + str(int(time.time()))
        settings = get_settings(session)
        safe_keywords = settings.default_focus_keywords or ""
        
        new_col = Collection(
            name=col_name, slug=slug, schedule_time=settings.default_schedule,
            context_length=settings.default_context_length, filter_max_articles=settings.default_filter_max,
            filter_age=settings.default_filter_age, system_prompt=settings.default_system_prompt, category_id=assign_cat,
            focus_keywords=safe_keywords
        )
        session.add(new_col)
        session.commit()
        session.refresh(new_col)
        
        for sub in subs:
            if not session.exec(select(Feed).where(Feed.collection_id == new_col.id, Feed.url == sub.url)).first():
                session.add(Feed(url=sub.url, collection_id=new_col.id))
        session.commit()
        
    return Response(headers={"HX-Redirect": "/collections"})


# --- NEW: Add Single Feed to Collection ---
@app.post("/collections/add_feed_by_url")
def add_feed_by_url(collection_id: int = Form(...), url: str = Form(...)):
    with Session(engine) as session:
        if not session.exec(select(Feed).where(Feed.collection_id == collection_id, Feed.url == url)).first():
            session.add(Feed(url=url, collection_id=collection_id)); session.commit()
            return HTMLResponse("<span style='color: #4CAF50;'>Feed added! You can safely close this window.</span>")
        else:
            return HTMLResponse("<span style='color: #888;'>This feed is already in the collection.</span>")

@app.post("/categories/add")
def add_category(name: str = Form(...)):
    with Session(engine) as session:
        if not session.exec(select(Category).where(Category.name == name)).first():
            session.add(Category(name=name)); session.commit()
    return Response(headers={"HX-Refresh": "true"})



@app.post("/subscriptions/add")
def add_subscription(url: str = Form(...), category_id: str = Form("none")):
    with Session(engine) as session:
        if not session.exec(select(Subscription).where(Subscription.url == url)).first():
            try:
                f = fetch_external_feed(url)
                title = f.feed.get('title', 'New Feed') if f else 'New Feed'
            except: title = "New Feed"
            
            # Safely parse the dropdown value
            cat = int(category_id) if category_id and category_id.isdigit() else None
            
            session.add(Subscription(url=url, title=title, category_id=cat))
            session.commit()
            
    from threading import Thread
    Thread(target=sync_all_feeds).start()
    return Response(headers={"HX-Refresh": "true"})


@app.post("/subscriptions/{sub_id}/change_category")
def change_subscription_category(sub_id: int, category_id: str = Form("none")):
    """Moves an existing subscription to a new category."""
    with Session(engine) as session:
        sub = session.get(Subscription, sub_id)
        if sub:
            cat = int(category_id) if category_id and category_id.isdigit() else None
            sub.category_id = cat
            session.add(sub)
            session.commit()
    return Response(headers={"HX-Refresh": "true"})

@app.get("/components/category_options")
def get_category_options():
    """Returns HTMX-ready <option> tags, with built-in error catching."""
    try:
        with Session(engine) as session:
            cats = session.exec(select(Category).order_by(Category.name)).all()
            options = '<option value="none">-- Uncategorized --</option>'
            for c in cats:
                # Safely handle the string just in case a category has no name
                name_str = html.escape(str(c.name)) if c.name else "Unnamed"
                options += f'<option value="{c.id}">{name_str}</option>'
            return HTMLResponse(options)
    except Exception as e:
        logger.error(f"Failed to load category options: {e}")
        return HTMLResponse(f'<option value="none">Error loading categories</option>')



# ... (Keep existing /subscriptions/import_opml and /export.opml and settings endpoints) ...
@app.get("/subscriptions/export.opml")
def export_subscriptions_opml():
    with Session(engine) as session:
        subs = session.exec(select(Subscription)).all()
        opml = ET.Element("opml", version="1.0")
        head = ET.SubElement(opml, "head")
        ET.SubElement(head, "title").text = "Feed Factory Subscriptions"
        body = ET.SubElement(opml, "body")
        for sub in subs:
            cat_name = ""
            if sub.category_id:
                cat = session.get(Category, sub.category_id)
                if cat: cat_name = cat.name
            ET.SubElement(body, "outline", type="rss", text=sub.title or sub.url, xmlUrl=sub.url, category=cat_name)
        return StreamingResponse(
            io.BytesIO(ET.tostring(opml, encoding="utf-8")), media_type="application/xml", 
            headers={"Content-Disposition": 'attachment; filename="subscriptions.opml"'}
        )

@app.post("/subscriptions/import_opml", response_class=HTMLResponse)
async def import_subscriptions_opml(request: Request, file: UploadFile = File(...)):
    content_bytes = await file.read()
    try: content_str = content_bytes.decode("utf-8")
    except: content_str = content_bytes.decode("latin-1")
    content_str = re.sub(r'&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+);)', '&amp;', content_str)
    feeds_to_import = []
    try:
        root = ET.fromstring(content_str)
        body = root.find('body')
        if body is not None:
            def parse_outlines(elements, current_category=None):
                for elem in elements:
                    if not elem.tag.endswith('outline'): continue
                    url = elem.get('xmlUrl') or elem.get('url')
                    title = elem.get('text') or elem.get('title') or url
                    cat = elem.get('category') or current_category
                    if url: feeds_to_import.append({'url': url, 'title': title, 'category': cat})
                    else:
                        folder_title = elem.get('title') or elem.get('text')
                        parse_outlines(list(elem), current_category=folder_title)
            parse_outlines(list(body))
        with Session(engine) as session:
            for feed_data in feeds_to_import:
                url = feed_data['url']; title = feed_data['title']; cat_name = feed_data['category']; cat_id = None
                if cat_name:
                    cat = session.exec(select(Category).where(Category.name == cat_name)).first()
                    if not cat:
                        cat = Category(name=cat_name)
                        session.add(cat); session.commit(); session.refresh(cat)
                    cat_id = cat.id
                if not session.exec(select(Subscription).where(Subscription.url == url)).first():
                    session.add(Subscription(url=url, title=title, category_id=cat_id))
            session.commit()
    except Exception as e: return Response(f"Error parsing OPML: {str(e)}", status_code=400)
    from threading import Thread
    Thread(target=sync_all_feeds).start()
    return get_category_tiles(request)




@app.post("/reader/force_sync")
def force_sync_all(background_tasks: BackgroundTasks):
    """Triggers a background sync without freezing the UI."""
    # Note: If you have a specific scraping function like `update_all_feeds()`,
    # you can uncomment the line below to run it immediately in the background:
    background_tasks.add_task(sync_all_feeds)
    return HTMLResponse("Sync Started")




@app.get("/settings", response_class=HTMLResponse)
def read_settings(request: Request):
    with Session(engine) as session:
        settings = get_settings(session)
        return templates.TemplateResponse("settings.html", {"request": request, "settings": settings})

@app.post("/settings/update")
async def update_global_settings(request: Request):
    """Bulletproof save endpoint using safe FormData extraction."""
    form = await request.form()
    
    with Session(engine) as session:
        settings = get_settings(session)
        
        settings.api_type = "openai"
        
        # Safely extract and apply strings
        if form.get("api_endpoint") is not None: settings.api_endpoint = form.get("api_endpoint")
        if form.get("api_key") is not None: settings.api_key = form.get("api_key")
        if form.get("model_name") is not None: settings.model_name = clean_model_id(form.get("model_name"))
        if form.get("default_schedule") is not None: settings.default_schedule = form.get("default_schedule")
        if form.get("default_filter_age") is not None: settings.default_filter_age = form.get("default_filter_age")
        if form.get("default_system_prompt") is not None: settings.default_system_prompt = form.get("default_system_prompt")
        if form.get("reader_font_family") is not None: settings.reader_font_family = form.get("reader_font_family")
        if form.get("reader_font_size") is not None: settings.reader_font_size = form.get("reader_font_size")
        if form.get("reader_line_height") is not None: settings.reader_line_height = form.get("reader_line_height")
        if form.get("default_focus_keywords") is not None: settings.default_focus_keywords = form.get("default_focus_keywords")
        if form.get("scraper_backend") is not None: settings.scraper_backend = form.get("scraper_backend")
        if form.get("apify_api_key") is not None: settings.apify_api_key = form.get("apify_api_key")
        
        # Safely extract and apply integers
        try:
            if form.get("default_context_length"): settings.default_context_length = int(form.get("default_context_length"))
            if form.get("default_filter_max"): settings.default_filter_max = int(form.get("default_filter_max"))
            if form.get("retention_read_days"): settings.retention_read_days = int(form.get("retention_read_days"))
            if form.get("retention_unread_days"): settings.retention_unread_days = int(form.get("retention_unread_days"))
            if form.get("pwa_offline_limit"): settings.pwa_offline_limit = int(form.get("pwa_offline_limit"))
        except ValueError:
            pass # Ignore invalid numbers rather than crashing
            
        session.add(settings)
        session.commit()
        
    return HTMLResponse("<span style='color: #4CAF50; font-weight: bold;'>✅ Settings Saved Successfully!</span>")



@app.post("/settings/test_llm")
async def test_llm_connection(request: Request):
    """Tests the LLM connection using the currently typed inputs, even if unsaved."""
    form = await request.form()
    
    with Session(engine) as session:
        # Load base settings, but override them with whatever is typed in the form right now
        settings = get_settings(session)
        if form.get("api_endpoint"): settings.api_endpoint = form["api_endpoint"]
        if form.get("api_key"): settings.api_key = form["api_key"]
        if form.get("model_name"): settings.model_name = form["model_name"]
        
    try:
        # Send a tiny prompt to verify the connection
        res = call_llm(settings, "Reply with 'Connection successful!' and nothing else.", "You are a helpful assistant.")
        return HTMLResponse(f"<span style='color: #4CAF50; font-weight: bold;'>✅ {res}</span>")
    except Exception as e:
        return HTMLResponse(f"<span style='color: #ff4444; font-weight: bold;'>❌ Failed: {str(e)}</span>")





@app.get("/settings/backup")
def backup_database():
    """Downloads the raw SQLite database file."""
    timestamp = int(time.time())
    return FileResponse(
        DB_FILE, 
        media_type="application/octet-stream", 
        filename=f"feedfactory_backup_{timestamp}.db"
    )

@app.post("/settings/restore")
async def restore_database(file: UploadFile = File(...)):
    """Overwrites the current database with an uploaded backup."""
    content = await file.read()
    with open(DB_FILE, "wb") as f:
        f.write(content)
    return HTMLResponse("<span style='color: #4CAF50; font-weight: bold;'>Database restored! Please restart your Docker container to apply changes.</span>")


@app.get("/collections", response_class=HTMLResponse)
def manage_collections(request: Request):
    with Session(engine) as session:
        collections = session.exec(select(Collection)).all()
        categories = session.exec(select(Category)).all()
        settings = get_settings(session)
        missing_auth = not settings.api_endpoint
        return templates.TemplateResponse("collections.html", {
            "request": request, "collections": collections, "categories": categories, "default_prompt": settings.default_system_prompt,
            "server_time": datetime.datetime.now().strftime("%H:%M"), "missing_auth": missing_auth
        })


@app.post("/collections/add")
def add_collection(name: str = Form(...), slug: str = Form(...), category_id: str = Form("none")):
    with Session(engine) as session:
        if session.exec(select(Collection).where(Collection.slug == slug)).first(): return Response(content="Error: Slug exists", status_code=400)
        g = get_settings(session)
        cat_id = None if category_id == "none" else int(category_id)
        
        # FIX 1 (Repeated): Safely fallback to an empty string
        safe_keywords = g.default_focus_keywords or ""
        
        col = Collection(
            name=name, slug=slug, schedule_time=g.default_schedule, 
            context_length=g.default_context_length, filter_max_articles=g.default_filter_max, 
            filter_age=g.default_filter_age, system_prompt=g.default_system_prompt, 
            category_id=cat_id, focus_keywords=safe_keywords
        )
        session.add(col)
        session.commit()
    return Response(headers={"HX-Refresh": "true"})


@app.post("/collections/{cid}/update")
def update_collection(cid: int, name: str = Form(...), slug: str = Form(...), category_id: str = Form("none")):
    with Session(engine) as session:
        col = session.get(Collection, cid)
        if not col: return Response("Not found", 404)
        old_slug = col.slug
        if slug != old_slug:
            if session.exec(select(Collection).where(Collection.slug == slug)).first(): return Response("Error: Slug taken", 400)
            if os.path.exists(f"/app/data/feeds/{old_slug}.xml"): os.rename(f"/app/data/feeds/{old_slug}.xml", f"/app/data/feeds/{slug}.xml")
        col.name = name; col.slug = slug
        col.category_id = None if category_id == "none" else int(category_id)
        session.add(col); session.commit()
    return Response(headers={"HX-Refresh": "true"})

@app.delete("/collections/{cid}")
def delete_collection(cid: int):
    with Session(engine) as session:
        col = session.get(Collection, cid)
        if col:
            if os.path.exists(f"/app/data/feeds/{col.slug}.xml"): os.remove(f"/app/data/feeds/{col.slug}.xml")
            for feed in col.feeds: session.delete(feed)
            session.delete(col); session.commit()
    return Response(headers={"HX-Refresh": "true"})

@app.post("/collections/{cid}/update_settings")
def update_settings(cid: int, schedule_time: str = Form(...), context_length: int = Form(...), filter_max_articles: int = Form(...),max_articles_per_topic: int = Form(...), filter_age: str = Form(...), focus_keywords: str = Form("")):
    with Session(engine) as session:
        col = session.get(Collection, cid)
        if col: 
            col.schedule_time = schedule_time; col.context_length = context_length; 
            col.filter_max_articles = filter_max_articles; col.filter_age = filter_age; 
            col.max_articles_per_topic = max_articles_per_topic;
            col.focus_keywords = focus_keywords # NEW
            session.add(col); session.commit()
    return "Saved"


@app.post("/collections/{cid}/update_prompt")
def update_prompt(cid: int, system_prompt: str = Form(...)):
    with Session(engine) as session:
        col = session.get(Collection, cid)
        if col: col.system_prompt = system_prompt; session.add(col); session.commit()
    return "Saved"

@app.post("/collections/{cid}/add_feed")
def add_feed(cid: int, url: str = Form(...)):
    with Session(engine) as session:
        session.add(Feed(url=url, collection_id=cid)); session.commit()
        col = session.get(Collection, cid)
        return HTMLResponse(render_feed_rows(cid, col.feeds))

@app.delete("/feeds/{fid}")
def delete_feed(fid: int):
    with Session(engine) as session:
        feed = session.get(Feed, fid)
        cid = feed.collection_id; session.delete(feed); session.commit()
        col = session.get(Collection, cid)
        return HTMLResponse(render_feed_rows(cid, col.feeds))

@app.post("/collections/{cid}/toggle_active")
def toggle_active(cid: int):
    with Session(engine) as session:
        col = session.get(Collection, cid)
        if col:
            col.is_active = not col.is_active
            session.add(col)
            session.commit()
    return "Toggled"



@app.post("/collections/{cid}/trigger")
def trigger_now(cid: int):
    from threading import Thread
    t = Thread(target=generate_digest_for_collection, args=(cid,))
    t.start()
    return "Started"

@app.post("/collections/trigger_all")
def trigger_all():
    from threading import Thread
    def run_all():
        with Session(engine) as session: 
            # Filter out disabled collections
            cids = [c.id for c in session.exec(select(Collection).where(Collection.is_active == True)).all()]
        for cid in cids:
            try: generate_digest_for_collection(cid)
            except: pass
    t = Thread(target=run_all); t.start()
    return "Started All"


@app.get("/status.json")
def get_all_status():
    with Session(engine) as session:
        collections = session.exec(select(Collection)).all()
        data = {}
        for col in collections:
            text = "Pending"; status = "pending"
            if col.is_generating: text = "Generating..."; status = "generating"
            elif col.last_run: text = col.last_run.strftime('%d %b %H:%M'); status = "done"
            data[col.id] = {"text": text, "status": status}
        return data

@app.get("/collections/{cid}/export.opml")
def export_opml(cid: int):
    with Session(engine) as session:
        col = session.get(Collection, cid)
        if not col: return Response("Not found", 404)
        opml = ET.Element("opml", version="1.0"); head = ET.SubElement(opml, "head"); ET.SubElement(head, "title").text = f"{col.name} Feeds"; body = ET.SubElement(opml, "body")
        for feed in col.feeds: ET.SubElement(body, "outline", type="rss", text=feed.url, xmlUrl=feed.url)
        return StreamingResponse(io.BytesIO(ET.tostring(opml, encoding="utf-8")), media_type="application/xml", headers={"Content-Disposition": f'attachment; filename="{col.slug}.opml"'})

@app.post("/collections/{cid}/import_opml")
async def import_opml(cid: int, file: UploadFile = File(...)):
    content_bytes = await file.read()
    try: content_str = content_bytes.decode("utf-8")
    except: content_str = content_bytes.decode("latin-1")
    content_str = re.sub(r'&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+);)', '&amp;', content_str)
    try:
        root = ET.fromstring(content_str); urls = []
        for elem in root.iter():
            if elem.tag.endswith('outline'):
                url = elem.get('xmlUrl') or elem.get('url')
                if url: urls.append(url)
        with Session(engine) as session:
            for url in urls:
                if not session.exec(select(Feed).where(Feed.collection_id == cid, Feed.url == url)).first(): session.add(Feed(url=url, collection_id=cid))
            session.commit()
            col = session.get(Collection, cid)
            return HTMLResponse(render_feed_rows(cid, col.feeds))
    except Exception as e:
        return Response(f"Error: {str(e)}", 400)

@app.get("/feeds/{slug}.xml")
def get_feed_xml(slug: str):
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
    
    // The core files needed to launch the app UI offline
    const APP_SHELL = [
        '/',
        '/reader/categories',
        '/static/logo.svg',
        '/manifest.json'
    ];

    self.addEventListener('install', event => {
        self.skipWaiting(); // Force the new service worker to activate immediately
        event.waitUntil(
            caches.open(CACHE_NAME).then(cache => {
                console.log('[Service Worker] Pre-caching App Shell');
                return cache.addAll(APP_SHELL);
            })
        );
    });

    // Clean up old v1 caches so they don't take up space
    self.addEventListener('activate', event => {
        event.waitUntil(
            caches.keys().then(cacheNames => {
                return Promise.all(
                    cacheNames.map(cacheName => {
                        if (cacheName !== CACHE_NAME) {
                            console.log('[Service Worker] Clearing old cache:', cacheName);
                            return caches.delete(cacheName);
                        }
                    })
                );
            }).then(() => self.clients.claim())
        );
    });

    self.addEventListener('fetch', event => {
        if (event.request.method !== 'GET') return;
        
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const resClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, resClone);
                    });
                    return response;
                })
                .catch(async () => {
                    // 1. Try to find the exact request in the cache
                    const cachedResponse = await caches.match(event.request);
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    
                    // 2. Fallback: If it's a browser navigation request (like opening the app)
                    // and we couldn't find it, forcefully serve the cached root App Shell.
                    if (event.request.mode === 'navigate') {
                        return caches.match('/');
                    }
                })
        );
    });
    """
    return Response(content=js, media_type="application/javascript")

