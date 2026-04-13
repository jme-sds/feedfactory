"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { articles, categories, subscriptions, topicTags, type Article } from "@/lib/api";
import { EntityPill, EntityOverflowPill, TopicTagPill, PersonalTagPill } from "@/components/ui/EntityPill";
import { useReaderStore } from "@/lib/store";
import {
  ArrowLeft, Filter, CheckSquare, CheckCheck, CircleDot, Sparkles,
  X, MoreVertical, ScanText, FolderInput, Trash2, ChevronDown, Tag
} from "lucide-react";
import { useState, useMemo, useEffect, useRef } from "react";

interface Filters {
  status: "all" | "unread" | "read";
  includeKw: string;
  excludeKw: string;
  since: string;
  topicTags: string[];
  entityTags: string[];
}

export default function ArticleStream() {
  const qc = useQueryClient();
  const {
    selectedCategoryId, selectedFeedId, selectedArticle,
    selectArticle, goBack,
    selectModeActive, setSelectModeActive,
    selectedArticleUrls, toggleSelectedArticle, clearSelection,
    tagBrowseMode, selectedTagFilter, selectTagFilter, selectedEntityFilter, selectEntityFilter,
  } = useReaderStore();

  const isFavoritesView = selectedCategoryId === "favorites" && !selectedFeedId;
  const [filters, setFilters] = useState<Filters>({
    status: isFavoritesView ? "all" : "unread",
    includeKw: "", excludeKw: "", since: "",
    topicTags: [], entityTags: [],
  });

  // Switch default filter when entering/leaving favorites view
  useEffect(() => {
    setFilters((f) => ({ ...f, status: isFavoritesView ? "all" : "unread" }));
  }, [isFavoritesView]);

  // Sync tag browse selection into topic/entity filters
  useEffect(() => {
    setFilters((f) => ({ ...f, topicTags: selectedTagFilter ? [selectedTagFilter] : [] }));
  }, [selectedTagFilter]);

  useEffect(() => {
    setFilters((f) => ({ ...f, entityTags: selectedEntityFilter ? [selectedEntityFilter] : [] }));
  }, [selectedEntityFilter]);

  const [filterOpen, setFilterOpen] = useState(false);
  const [streamMenuOpen, setStreamMenuOpen] = useState(false);
  const [changeCatOpen, setChangeCatOpen] = useState(false);
  const [targetCatId, setTargetCatId] = useState<string>("");
  const [localAutoScrape, setLocalAutoScrape] = useState<boolean | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryHtml, setSummaryHtml] = useState<string | null>(null);
  const [scrapeOnSummarize, setScrapeOnSummarize] = useState(false);

  // Resolve effective feed/category params
  const feedId = selectedFeedId === "__all__" ? undefined : selectedFeedId || undefined;
  const categoryId = selectedFeedId === "__all__" ? selectedCategoryId : selectedFeedId ? undefined : selectedCategoryId;

  // Feed management — only applies when a specific subscription feed is open
  const isSubscriptionFeed = !!(selectedFeedId && selectedFeedId !== "__all__" && selectedFeedId.startsWith("sub_"));
  const feedDbId = isSubscriptionFeed ? parseInt(selectedFeedId!.split("_")[1]) : null;

  const { data: rawArticles = [], isLoading } = useQuery({
    queryKey: ["articles", categoryId, feedId],
    queryFn: () => articles.list({ category_id: categoryId, feed_id: feedId }),
    refetchInterval: 60_000,
  });

  // Use cached feeds query to get current auto_scrape state
  const { data: feedsData } = useQuery({
    queryKey: ["feeds", selectedCategoryId],
    queryFn: () => categories.feeds(selectedCategoryId),
    enabled: isSubscriptionFeed,
  });
  const currentFeed = isSubscriptionFeed ? feedsData?.feeds.find(f => f.id === selectedFeedId) : null;
  const currentAutoScrape = localAutoScrape !== null ? localAutoScrape : (currentFeed?.auto_scrape ?? false);

  const { data: catsData } = useQuery({
    queryKey: ["categories"],
    queryFn: () => categories.list(),
    enabled: changeCatOpen,
  });

  const { data: allTopicTagsList = [] } = useQuery({
    queryKey: ["topic-tags"],
    queryFn: topicTags.list,
  });

  // Derive entity options from loaded articles (top 60 by frequency)
  const allEntityOptions = useMemo(() => {
    const freq = new Map<string, number>();
    rawArticles.forEach((a) => (a.entities ?? []).forEach((e) => {
      freq.set(e.text, (freq.get(e.text) ?? 0) + 1);
    }));
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([text]) => text);
  }, [rawArticles]);

  // Client-side filter
  const filtered = useMemo(() => {
    return rawArticles.filter((a) => {
      // Keep the currently-open article visible even if it's been marked read,
      // so the user sees it greyed out rather than suddenly disappearing.
      if (filters.status === "unread" && a.is_read && a.link !== selectedArticle?.link) return false;
      if (filters.status === "read" && !a.is_read) return false;
      const text = (a.title + " " + a.source_title).toLowerCase();
      if (filters.includeKw) {
        const kws = filters.includeKw.toLowerCase().split(",").map((k) => k.trim()).filter(Boolean);
        if (!kws.some((k) => text.includes(k))) return false;
      }
      if (filters.excludeKw) {
        const kws = filters.excludeKw.toLowerCase().split(",").map((k) => k.trim()).filter(Boolean);
        if (kws.some((k) => text.includes(k))) return false;
      }
      if (filters.since) {
        const sinceTs = new Date(filters.since).getTime() / 1000;
        if (a.published < sinceTs) return false;
      }
      if (filters.topicTags.length > 0) {
        if (!filters.topicTags.some((t) => (a.topic_tags ?? []).includes(t))) return false;
      }
      if (filters.entityTags.length > 0) {
        const texts = (a.entities ?? []).map((e) => e.text);
        if (!filters.entityTags.some((t) => texts.includes(t))) return false;
      }
      return true;
    });
  }, [rawArticles, filters, selectedArticle?.link]);

  const handleMarkAllRead = async () => {
    const urls = filtered.filter((a) => !a.is_read).map((a) => a.link);
    if (!urls.length) return;
    await articles.markReadBulk(urls);
    qc.invalidateQueries({ queryKey: ["articles"] });
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["feeds"] });
  };

  const handleMarkSelectedRead = async () => {
    const urls = Array.from(selectedArticleUrls);
    if (!urls.length) return;
    await articles.markReadBulk(urls);
    clearSelection();
    qc.invalidateQueries({ queryKey: ["articles"] });
    qc.invalidateQueries({ queryKey: ["categories"] });
  };

  const handleMarkSelectedUnread = async () => {
    const urls = Array.from(selectedArticleUrls);
    if (!urls.length) return;
    await articles.markUnreadBulk(urls);
    clearSelection();
    qc.invalidateQueries({ queryKey: ["articles"] });
    qc.invalidateQueries({ queryKey: ["categories"] });
  };

  const handleSummarizeSelected = async () => {
    const urls = Array.from(selectedArticleUrls);
    if (!urls.length) return;
    setSummarizing(true);
    setSummaryHtml(null);
    try {
      const result = await articles.summarizeBulk(urls, scrapeOnSummarize);
      setSummaryHtml(result.summary);
    } catch (e: any) {
      setSummaryHtml(`<p style="color:#ff4444">Error: ${e.message}</p>`);
    }
    setSummarizing(false);
  };

  const handleToggleAutoScrape = async () => {
    setStreamMenuOpen(false);
    if (feedDbId === null) return;
    const result = await subscriptions.toggleScrape(feedDbId);
    setLocalAutoScrape(result.auto_scrape);
    qc.invalidateQueries({ queryKey: ["feeds", selectedCategoryId] });
  };

  const handleChangeCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (feedDbId === null) return;
    const catId = targetCatId && targetCatId !== "none" ? parseInt(targetCatId) : null;
    await subscriptions.changeCategory(feedDbId, catId);
    setChangeCatOpen(false);
    qc.invalidateQueries({ queryKey: ["feeds", selectedCategoryId] });
    qc.invalidateQueries({ queryKey: ["categories"] });
    goBack();
  };

  const handleDeleteFeed = async () => {
    setStreamMenuOpen(false);
    if (feedDbId === null) return;
    if (!confirm(`Remove feed "${currentFeed?.name ?? "this feed"}"?`)) return;
    await subscriptions.delete(feedDbId);
    qc.invalidateQueries({ queryKey: ["feeds", selectedCategoryId] });
    qc.invalidateQueries({ queryKey: ["categories"] });
    goBack();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Sub-header */}
      <div className="shrink-0 bg-background border-b border-border px-3 py-2 flex items-center gap-2">
        <button
          onClick={() => {
            if (tagBrowseMode && selectedTagFilter) { selectTagFilter(null); }
            else if (tagBrowseMode && selectedEntityFilter) { selectEntityFilter(null); }
            else { goBack(); }
          }}
          className="p-1.5 rounded-md text-muted hover:text-white hover:bg-white/5"
        >
          <ArrowLeft size={18} />
        </button>
        <span className="font-semibold text-sm flex-1 truncate">
          {selectedTagFilter
            ? <span className="flex items-center gap-1.5"><Tag size={13} className="text-yellow-400" />{selectedTagFilter}</span>
            : selectedEntityFilter
            ? <span className="flex items-center gap-1.5"><Tag size={13} className="text-sky-400" />{selectedEntityFilter}</span>
            : isFavoritesView ? "Favorites"
            : selectedFeedId === "__all__" ? "All Articles"
            : (currentFeed?.name ?? "Articles")}
        </span>
        <button onClick={() => setFilterOpen(!filterOpen)} className={`relative p-1.5 rounded-md transition-colors ${filterOpen || filters.topicTags.length > 0 || filters.entityTags.length > 0 || filters.includeKw || filters.excludeKw || filters.since ? "text-primary bg-primary/10" : "text-muted hover:text-white hover:bg-white/5"}`}>
          <Filter size={16} />
          {(filters.topicTags.length + filters.entityTags.length) > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-primary text-white text-[8px] flex items-center justify-center font-bold">
              {filters.topicTags.length + filters.entityTags.length}
            </span>
          )}
        </button>
        <button onClick={() => setSelectModeActive(!selectModeActive)} className={`p-1.5 rounded-md transition-colors ${selectModeActive ? "text-primary bg-primary/10" : "text-muted hover:text-white hover:bg-white/5"}`}>
          <CheckSquare size={16} />
        </button>
        <div className="relative">
          <button
            onClick={() => setStreamMenuOpen(!streamMenuOpen)}
            className="p-1.5 rounded-md text-muted hover:text-white hover:bg-white/5 transition-colors"
          >
            <MoreVertical size={16} />
          </button>
          {streamMenuOpen && (
            <div className="absolute right-0 top-8 w-48 bg-surface border border-border rounded-lg shadow-xl py-1 z-50 text-sm">
              <button
                onClick={() => { setStreamMenuOpen(false); handleMarkAllRead(); }}
                className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-white/5"
              >
                <CheckCheck size={14} /> Mark All Read
              </button>
              {isSubscriptionFeed && (
                <>
                  <button
                    onClick={handleToggleAutoScrape}
                    className={`flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-white/5 ${currentAutoScrape ? "text-primary" : ""}`}
                  >
                    <ScanText size={14} /> {currentAutoScrape ? "Auto-Scrape: On" : "Auto-Scrape: Off"}
                  </button>
                  <button
                    onClick={() => { setStreamMenuOpen(false); setTargetCatId("none"); setChangeCatOpen(true); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-white/5"
                  >
                    <FolderInput size={14} /> Change Category
                  </button>
                  <button
                    onClick={handleDeleteFeed}
                    className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-white/5 text-danger"
                  >
                    <Trash2 size={14} /> Delete Feed
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {streamMenuOpen && (
        <div className="fixed inset-0 z-30" onClick={() => setStreamMenuOpen(false)} />
      )}

      {/* Filter panel */}
      {filterOpen && (
        <div className="bg-surface border-b border-border px-3 py-3 space-y-2 text-sm">
          <div className="flex gap-2">
            {(["unread", "all", "read"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilters((f) => ({ ...f, status: s }))}
                className={`flex-1 py-1.5 rounded-md capitalize text-xs font-medium transition-colors ${
                  filters.status === s ? "bg-primary text-white" : "bg-white/5 text-muted hover:bg-white/10"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <input
            type="text"
            placeholder="Include keywords (comma-separated)"
            value={filters.includeKw}
            onChange={(e) => setFilters((f) => ({ ...f, includeKw: e.target.value }))}
            className="w-full bg-background border border-border rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-primary"
          />
          <input
            type="text"
            placeholder="Exclude keywords (comma-separated)"
            value={filters.excludeKw}
            onChange={(e) => setFilters((f) => ({ ...f, excludeKw: e.target.value }))}
            className="w-full bg-background border border-border rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-primary"
          />
          <div className="flex items-center gap-2">
            <label className="text-muted text-xs">Published since:</label>
            <input
              type="date"
              value={filters.since}
              onChange={(e) => setFilters((f) => ({ ...f, since: e.target.value }))}
              className="flex-1 bg-background border border-border rounded px-2.5 py-1 text-xs focus:outline-none focus:border-primary"
            />
            {(filters.includeKw || filters.excludeKw || filters.since || filters.topicTags.length > 0 || filters.entityTags.length > 0) && (
              <button
                onClick={() => setFilters((f) => ({ ...f, includeKw: "", excludeKw: "", since: "", topicTags: [], entityTags: [] }))}
                className="text-muted hover:text-white"
                title="Clear all filters"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <label className="text-muted text-xs w-20 shrink-0">Topic Tags:</label>
            <TagFilterDropdown
              options={allTopicTagsList.filter(t => t.is_active).map(t => t.name)}
              selected={filters.topicTags}
              onChange={(v) => setFilters((f) => ({ ...f, topicTags: v }))}
              placeholder="All tags"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-muted text-xs w-20 shrink-0">Entities:</label>
            <TagFilterDropdown
              options={allEntityOptions}
              selected={filters.entityTags}
              onChange={(v) => setFilters((f) => ({ ...f, entityTags: v }))}
              placeholder="All entities"
            />
          </div>
        </div>
      )}

      {/* Bulk action bar */}
      {selectModeActive && selectedArticleUrls.size > 0 && (
        <div className="bg-primary/10 border-b border-primary/30 px-3 py-2 flex items-center gap-2 text-sm">
          <span className="text-primary font-medium flex-1">{selectedArticleUrls.size} selected</span>
          <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
            <input type="checkbox" checked={scrapeOnSummarize} onChange={(e) => setScrapeOnSummarize(e.target.checked)} />
            Scrape
          </label>
          <button onClick={handleMarkSelectedUnread} title="Mark as unread" className="p-1.5 rounded text-muted hover:text-white">
            <CircleDot size={16} />
          </button>
          <button onClick={handleMarkSelectedRead} title="Mark as read" className="p-1.5 rounded text-muted hover:text-white">
            <CheckCheck size={16} />
          </button>
          <button onClick={handleSummarizeSelected} disabled={summarizing} className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary text-white text-xs disabled:opacity-50">
            <Sparkles size={14} />
            {summarizing ? "..." : "Summarize"}
          </button>
        </div>
      )}

      {/* Summary output */}
      {summaryHtml && (
        <div className="mx-3 my-2 p-3 bg-surface rounded-xl border border-border text-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted font-medium uppercase tracking-wide">AI Summary</span>
            <button onClick={() => setSummaryHtml(null)} className="text-muted hover:text-white"><X size={14} /></button>
          </div>
          <div className="reader-content text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: summaryHtml }} />
        </div>
      )}

      {/* Article list */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-12"><div className="spinner" /></div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-muted py-12 text-sm">No articles</div>
        ) : (
          filtered.map((article) => (
            <ArticleRow
              key={article.ui_id}
              article={article}
              selectMode={selectModeActive}
              selected={selectedArticleUrls.has(article.link)}
              onSelect={() => toggleSelectedArticle(article.link)}
              onClick={() => {
                if (selectModeActive) {
                  toggleSelectedArticle(article.link);
                } else {
                  selectArticle(article);
                }
              }}
              qc={qc}
            />
          ))
        )}
      </div>

      {/* Change category modal */}
      {changeCatOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-surface border border-border rounded-xl p-6 w-full max-w-sm">
            <h2 className="font-semibold mb-4">Change Category</h2>
            <form onSubmit={handleChangeCategory} className="space-y-3">
              <select
                value={targetCatId}
                onChange={(e) => setTargetCatId(e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary"
              >
                <option value="none">-- Uncategorized --</option>
                {catsData?.categories.map((c) => (
                  <option key={c.id} value={String(c.id)}>{c.name}</option>
                ))}
              </select>
              <div className="flex gap-2">
                <button type="button" onClick={() => setChangeCatOpen(false)} className="flex-1 py-2 rounded-lg border border-border text-sm hover:bg-white/5">Cancel</button>
                <button type="submit" className="flex-1 py-2 rounded-lg bg-primary text-sm font-medium hover:bg-primary-hover">Move</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const ARTICLE_ROW_MAX_PILLS = 3;

// ---------------------------------------------------------------------------
// TagFilterDropdown — reusable checklist dropdown for tag/entity filtering
// ---------------------------------------------------------------------------

function TagFilterDropdown({
  options,
  selected,
  onChange,
  placeholder,
}: {
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const filtered = options.filter((o) => o.toLowerCase().includes(search.toLowerCase()));

  const toggle = (opt: string) => {
    onChange(selected.includes(opt) ? selected.filter((s) => s !== opt) : [...selected, opt]);
  };

  return (
    <div ref={containerRef} className="relative flex-1">
      <button
        type="button"
        onClick={() => { setOpen(!open); setSearch(""); }}
        className={`flex items-center justify-between w-full gap-1 px-2.5 py-1 rounded border text-xs transition-colors ${
          selected.length > 0
            ? "border-primary/60 bg-primary/10 text-primary"
            : "border-border bg-background text-muted hover:border-primary/40 hover:text-white"
        }`}
      >
        <span className="truncate">
          {selected.length === 0 ? placeholder : selected.join(", ")}
        </span>
        {selected.length > 0 && (
          <span
            className="shrink-0 w-4 h-4 rounded-full bg-primary/20 text-primary text-[9px] flex items-center justify-center font-bold"
            onClick={(e) => { e.stopPropagation(); onChange([]); }}
            title="Clear"
          >
            ×
          </span>
        )}
        <ChevronDown size={11} className="shrink-0 opacity-60" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-56 bg-surface border border-border rounded-lg shadow-xl z-50 py-1">
          <div className="px-2 pt-1 pb-1">
            <input
              autoFocus
              type="text"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
              className="w-full bg-background border border-border rounded px-2 py-1 text-xs focus:outline-none focus:border-primary"
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-xs text-muted text-center py-3">No matches</p>
            ) : (
              filtered.map((opt) => (
                <label key={opt} className="flex items-center gap-2 px-3 py-1.5 hover:bg-white/5 cursor-pointer text-xs">
                  <input
                    type="checkbox"
                    checked={selected.includes(opt)}
                    onChange={() => toggle(opt)}
                    className="accent-primary"
                  />
                  <span className="truncate">{opt}</span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ArticleRow({
  article,
  selectMode,
  selected,
  onSelect,
  onClick,
  qc,
}: {
  article: Article;
  selectMode: boolean;
  selected: boolean;
  onSelect: () => void;
  onClick: () => void;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const personalTags = article.personal_tags ?? [];
  const topicTags = article.topic_tags ?? [];
  const entities = article.entities ?? [];
  // Merge order: personal (rose) → topic (amber) → NER entities (violet/blue/green)
  type PillItem =
    | { kind: "personal"; name: string }
    | { kind: "topic"; name: string }
    | { kind: "entity"; entity: import("@/lib/api").ArticleEntity };
  const allPills: PillItem[] = [
    ...personalTags.map((t) => ({ kind: "personal" as const, name: t })),
    ...topicTags.map((t) => ({ kind: "topic" as const, name: t })),
    ...entities.map((e) => ({ kind: "entity" as const, entity: e })),
  ];
  const visiblePills = allPills.slice(0, ARTICLE_ROW_MAX_PILLS);
  const overflowCount = allPills.length - visiblePills.length;
  return (
    <div
      className={`flex items-start gap-2 px-3 py-3 border-b border-border cursor-pointer hover:bg-white/5 transition-colors ${
        article.is_read ? "opacity-40" : ""
      } ${selected ? "bg-primary/10" : ""}`}
      onClick={onClick}
    >
      {selectMode && (
        <div className="pt-0.5 shrink-0">
          <div
            className={`w-4 h-4 rounded border transition-colors ${
              selected ? "bg-primary border-primary" : "border-border"
            }`}
          />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-xs text-muted uppercase tracking-wide truncate">{article.source_title}</span>
          <span className="text-xs text-muted shrink-0">{article.published_str}</span>
        </div>
        <p className="text-sm font-medium leading-snug line-clamp-2">{article.title}</p>
        {allPills.length > 0 && (
          <div className="mt-1.5 flex items-center gap-1 overflow-hidden min-w-0">
            {visiblePills.map((pill, i) => {
              const truncatable = i === visiblePills.length - 1 && overflowCount > 0;
              if (pill.kind === "personal") {
                return <PersonalTagPill key={i} name={pill.name} truncatable={truncatable} />;
              }
              if (pill.kind === "topic") {
                return <TopicTagPill key={i} name={pill.name} truncatable={truncatable} />;
              }
              return <EntityPill key={i} entity={pill.entity} truncatable={truncatable} />;
            })}
            {overflowCount > 0 && <EntityOverflowPill count={overflowCount} />}
          </div>
        )}
      </div>
    </div>
  );
}
