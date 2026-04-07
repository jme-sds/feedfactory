"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { articles, categories, subscriptions, feeds, type Article } from "@/lib/api";
import { useReaderStore } from "@/lib/store";
import {
  ArrowLeft, Filter, CheckSquare, CheckCheck, CircleDot, Sparkles,
  X, MoreVertical, ScanText, FolderInput, Trash2
} from "lucide-react";
import { useState, useMemo } from "react";

interface Filters {
  status: "all" | "unread" | "read";
  includeKw: string;
  excludeKw: string;
  since: string;
}

export default function ArticleStream() {
  const qc = useQueryClient();
  const {
    selectedCategoryId, selectedFeedId,
    selectArticle, goBack,
    selectModeActive, setSelectModeActive,
    selectedArticleUrls, toggleSelectedArticle, clearSelection,
  } = useReaderStore();

  const [filters, setFilters] = useState<Filters>({ status: "unread", includeKw: "", excludeKw: "", since: "" });
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

  // Client-side filter
  const filtered = useMemo(() => {
    return rawArticles.filter((a) => {
      if (filters.status === "unread" && a.is_read) return false;
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
      return true;
    });
  }, [rawArticles, filters]);

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
        <button onClick={goBack} className="p-1.5 rounded-md text-muted hover:text-white hover:bg-white/5">
          <ArrowLeft size={18} />
        </button>
        <span className="font-semibold text-sm flex-1 truncate">
          {selectedFeedId === "__all__" ? "All Articles" : (currentFeed?.name ?? "Articles")}
        </span>
        <button onClick={() => setFilterOpen(!filterOpen)} className={`p-1.5 rounded-md transition-colors ${filterOpen ? "text-primary bg-primary/10" : "text-muted hover:text-white hover:bg-white/5"}`}>
          <Filter size={16} />
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
            {(filters.includeKw || filters.excludeKw || filters.since) && (
              <button onClick={() => setFilters((f) => ({ ...f, includeKw: "", excludeKw: "", since: "" }))} className="text-muted hover:text-white">
                <X size={14} />
              </button>
            )}
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
      <div className="flex-1 overflow-y-auto">
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
      </div>
    </div>
  );
}
