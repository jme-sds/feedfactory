"use client";

import { useReaderStore } from "@/lib/store";
import { articles, personalTags, topicTags, type Article } from "@/lib/api";
import { EntityPill, TopicTagPill } from "@/components/ui/EntityPill";
import { X, ExternalLink, BookOpen, Sparkles, ArrowLeft, CircleDot, CircleCheck, Star, Tag } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";

export default function ArticlePanel({ isModal = false }: { isModal?: boolean }) {
  const { selectedArticle, selectArticle, goBack } = useReaderStore();
  const qc = useQueryClient();
  const [readerHtml, setReaderHtml] = useState<string | null>(null);
  const [loadingReader, setLoadingReader] = useState(false);
  const [summaryHtml, setSummaryHtml] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [readerMode, setReaderMode] = useState(false);
  const [localIsRead, setLocalIsRead] = useState<boolean | null>(null);
  const [localIsFavorited, setLocalIsFavorited] = useState<boolean | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const markedReadRef = useRef(false);

  // Topic tags — local state so adds/removes feel instant
  const [localTopicTags, setLocalTopicTags] = useState<string[] | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [tagInputOpen, setTagInputOpen] = useState(false);
  const tagInputRef = useRef<HTMLInputElement>(null);

  // Fetch all known topic tag names for autocomplete suggestions
  const { data: allTopicTags } = useQuery({
    queryKey: ["topic-tags"],
    queryFn: topicTags.list,
  });
  const knownTagNames = allTopicTags?.map((t) => t.name) ?? [];

  // Reset when article changes; auto-load reader for auto-scrape feeds
  useEffect(() => {
    setReaderHtml(null);
    setSummaryHtml(null);
    setReaderMode(false);
    setLocalIsRead(null);
    setLocalIsFavorited(null);
    setLocalTopicTags(null);
    setTagInput("");
    setTagInputOpen(false);
    markedReadRef.current = false;

    if (!selectedArticle) return;

    if (!selectedArticle.auto_scrape) return;

    const link = selectedArticle.link;
    let cancelled = false;
    setLoadingReader(true);
    articles.fetchContent(link)
      .then(result => {
        if (cancelled) return;
        setReaderHtml(result.html);
        setReaderMode(true);
      })
      .catch(() => {
        // silently fall back to normal view
      })
      .finally(() => {
        if (!cancelled) setLoadingReader(false);
      });

    return () => { cancelled = true; };
  }, [selectedArticle?.link]);

  // Mark article as read when user scrolls past the halfway point
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !selectedArticle || selectedArticle.is_read) return;

    const doMarkRead = async () => {
      if (markedReadRef.current) return;
      markedReadRef.current = true;
      const link = selectedArticle.link;
      setLocalIsRead(true);
      qc.setQueriesData<Article[]>({ queryKey: ["articles"] }, (old) =>
        old ? old.map((a) => (a.link === link ? { ...a, is_read: true } : a)) : old
      );
      await articles.markRead(link);
      qc.invalidateQueries({ queryKey: ["articles"] });
      qc.invalidateQueries({ queryKey: ["categories"] });
    };

    const checkScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const scrollable = scrollHeight - clientHeight;
      if (scrollable > 0 && scrollTop / scrollable >= 0.5) {
        doMarkRead();
      }
    };

    // For articles that fit entirely in the viewport (no scrolling needed), mark read after 3 seconds
    let shortTimer: ReturnType<typeof setTimeout> | null = null;
    const rafId = requestAnimationFrame(() => {
      if (el.scrollHeight <= el.clientHeight + 10) {
        shortTimer = setTimeout(doMarkRead, 3000);
      }
    });

    el.addEventListener("scroll", checkScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", checkScroll);
      cancelAnimationFrame(rafId);
      if (shortTimer) clearTimeout(shortTimer);
    };
  }, [selectedArticle?.link]);

  if (!selectedArticle) {
    if (isModal) return null;
    return (
      <div className="hidden lg:flex flex-col items-center justify-center h-full text-muted text-sm">
        Select an article to read
      </div>
    );
  }

  const a = selectedArticle;
  const isRead = localIsRead !== null ? localIsRead : a.is_read;
  const isFavorited = localIsFavorited !== null ? localIsFavorited : (a.is_favorited ?? false);

  const handleToggleFavorite = async () => {
    const next = !isFavorited;
    setLocalIsFavorited(next);
    if (next) {
      // Favoriting also marks unread
      setLocalIsRead(false);
      await articles.favorite(a.link);
    } else {
      await articles.unfavorite(a.link);
    }
    qc.invalidateQueries({ queryKey: ["articles"] });
    qc.invalidateQueries({ queryKey: ["categories"] });
  };

  const handleToggleRead = async () => {
    const next = !isRead;
    setLocalIsRead(next);
    if (next) {
      await articles.markRead(a.link);
    } else {
      await articles.markUnread(a.link);
    }
    qc.invalidateQueries({ queryKey: ["articles"] });
    qc.invalidateQueries({ queryKey: ["categories"] });
  };

  const handleReaderView = async () => {
    if (readerHtml) {
      setReaderMode(!readerMode);
      return;
    }
    setLoadingReader(true);
    try {
      const result = await articles.fetchContent(a.link);
      setReaderHtml(result.html);
      setReaderMode(true);
    } catch (e: any) {
      setReaderHtml(`<p style="color:#ff4444">Failed to fetch content: ${e.message}</p>`);
      setReaderMode(true);
    }
    setLoadingReader(false);
  };

  const handleSummarize = async () => {
    setSummarizing(true);
    const text = readerHtml
      ? stripHtml(readerHtml)
      : stripHtml(a.display_body);
    try {
      const result = await articles.summarize(text);
      setSummaryHtml(result.summary);
    } catch (e: any) {
      setSummaryHtml(`<p style="color:#ff4444">Error: ${e.message}</p>`);
    }
    setSummarizing(false);
  };

  // Use local state if the user has touched tags this session, else fall back to article data
  const currentTopicTags = localTopicTags ?? (a.topic_tags ?? []);

  const handleAddTag = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || currentTopicTags.includes(trimmed)) return;
    setLocalTopicTags([...currentTopicTags, trimmed]);
    setTagInput("");
    setTagInputOpen(false);
    try {
      await personalTags.train(a.id, trimmed, 1);
      qc.invalidateQueries({ queryKey: ["articles"] });
      qc.invalidateQueries({ queryKey: ["topic-tags"] });
    } catch {
      setLocalTopicTags(currentTopicTags); // rollback on error
    }
  };

  const handleRemoveTag = async (name: string) => {
    setLocalTopicTags(currentTopicTags.filter((t) => t !== name));
    try {
      await personalTags.train(a.id, name, 0);
      qc.invalidateQueries({ queryKey: ["articles"] });
    } catch {
      setLocalTopicTags(currentTopicTags); // rollback on error
    }
  };

  const displayContent = readerMode && readerHtml ? readerHtml : a.display_body;

  const container = (
    <div className="flex flex-col h-full bg-background">
      {/* Controls bar */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border bg-surface">
        {isModal ? (
          <button onClick={goBack} className="p-1.5 rounded-md text-muted hover:text-white hover:bg-white/5">
            <ArrowLeft size={18} />
          </button>
        ) : (
          <button onClick={() => selectArticle(null)} className="p-1.5 rounded-md text-muted hover:text-white hover:bg-white/5">
            <X size={18} />
          </button>
        )}
        <button
          onClick={handleToggleRead}
          title={isRead ? "Mark as unread" : "Mark as read"}
          className={`p-1.5 rounded-md transition-colors ${isRead ? "text-primary bg-primary/10" : "text-muted hover:text-white hover:bg-white/5"}`}
        >
          {isRead ? <CircleCheck size={16} /> : <CircleDot size={16} />}
        </button>
        <button
          onClick={handleToggleFavorite}
          title={isFavorited ? "Remove from favorites" : "Add to favorites"}
          className={`p-1.5 rounded-md transition-colors ${isFavorited ? "text-yellow-400 bg-yellow-400/10" : "text-muted hover:text-white hover:bg-white/5"}`}
        >
          <Star size={16} fill={isFavorited ? "currentColor" : "none"} />
        </button>
        <div className="flex-1" />
        <button
          onClick={handleReaderView}
          disabled={loadingReader}
          title="Reader view"
          className={`p-1.5 rounded-md transition-colors ${readerMode ? "text-primary bg-primary/10" : "text-muted hover:text-white hover:bg-white/5"} disabled:opacity-50`}
        >
          {loadingReader ? <div className="spinner" style={{ width: 16, height: 16 }} /> : <BookOpen size={16} />}
        </button>
        <button
          onClick={handleSummarize}
          disabled={summarizing}
          title="AI Summary"
          className={`p-1.5 rounded-md transition-colors ${summaryHtml ? "text-primary bg-primary/10" : "text-muted hover:text-white hover:bg-white/5"} disabled:opacity-50`}
        >
          {summarizing ? <div className="spinner" style={{ width: 16, height: 16 }} /> : <Sparkles size={16} />}
        </button>
        <a
          href={a.link}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1.5 rounded-md text-muted hover:text-white hover:bg-white/5"
        >
          <ExternalLink size={16} />
        </a>
      </div>

      {/* Content */}
      <div ref={bodyRef} className="flex-1 overflow-y-auto px-4 py-4 lg:px-8">
        <div className="max-w-2xl mx-auto">
        <p className="text-xs text-muted uppercase tracking-wide mb-2">{a.source_title}</p>
        <h1 className="text-xl font-bold leading-snug mb-3">{a.title}</h1>
        {/* Topic tags — interactive: add with + button, remove with × */}
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          {currentTopicTags.map((t) => (
            <TopicTagPill key={t} name={t} onRemove={() => handleRemoveTag(t)} />
          ))}
          {tagInputOpen ? (
            <span className="inline-flex items-center gap-1 relative">
              <input
                ref={tagInputRef}
                autoFocus
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); handleAddTag(tagInput); }
                  if (e.key === "Escape") { setTagInputOpen(false); setTagInput(""); }
                }}
                placeholder="tag name…"
                className="w-28 bg-background border border-yellow-400/40 rounded-full px-2.5 py-0.5 text-xs focus:outline-none focus:border-yellow-400/70 text-yellow-200"
                list="topic-tag-suggestions"
              />
              <datalist id="topic-tag-suggestions">
                {knownTagNames.filter((n) => !currentTopicTags.includes(n)).map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
              <button onClick={() => { setTagInputOpen(false); setTagInput(""); }} className="text-muted hover:text-white text-xs">
                <X size={12} />
              </button>
            </span>
          ) : (
            <button
              onClick={() => setTagInputOpen(true)}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs text-muted hover:text-white border border-dashed border-white/20 hover:border-white/40 transition-colors"
              title="Add tag"
            >
              <Tag size={11} /> tag
            </button>
          )}
        </div>

        {/* NER entity pills — read-only */}
        {(a.entities?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {(a.entities ?? []).map((e, i) => (
              <EntityPill key={`e-${i}`} entity={e} />
            ))}
          </div>
        )}
        <p className="text-xs text-muted mb-6">{a.published_str}</p>

        {/* AI Summary */}
        {summaryHtml && (
          <div className="mb-6 p-4 bg-surface rounded-xl border border-primary/30">
            <div className="flex items-center gap-1.5 mb-3">
              <Sparkles size={14} className="text-primary" />
              <span className="text-xs font-semibold text-primary uppercase tracking-wide">AI Summary</span>
            </div>
            <div className="reader-content text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: summaryHtml }} />
          </div>
        )}

        {/* Article body */}
        <div className="reader-content" dangerouslySetInnerHTML={{ __html: displayContent }} />
        </div>
      </div>
    </div>
  );

  if (isModal) {
    return (
      <div className="fixed inset-0 z-50 bg-background">
        {container}
      </div>
    );
  }

  return container;
}

function stripHtml(html: string): string {
  if (typeof document === "undefined") return html;
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}
