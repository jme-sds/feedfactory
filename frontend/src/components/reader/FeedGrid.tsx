"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { categories, subscriptions, feeds, collections, type FeedItem } from "@/lib/api";
import { useReaderStore } from "@/lib/store";
import { ArrowLeft, MoreVertical, CheckCheck, Trash2, FolderInput, ScanText, Pencil, Layers } from "lucide-react";
import { useState } from "react";

export default function FeedGrid({ onBack }: { onBack?: () => void }) {
  const qc = useQueryClient();
  const { selectedCategoryId, selectFeed, goBack, selectedFeedId } = useReaderStore();
  const handleBack = onBack ?? goBack;
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [catMenuOpen, setCatMenuOpen] = useState(false);
  const [changeCatFeedId, setChangeCatFeedId] = useState<FeedItem | null>(null);
  const [targetCatId, setTargetCatId] = useState<string>("");

  const { data, isLoading } = useQuery({
    queryKey: ["feeds", selectedCategoryId],
    queryFn: () => categories.feeds(selectedCategoryId),
    enabled: !!selectedCategoryId,
  });

  const { data: catsData } = useQuery({
    queryKey: ["categories"],
    queryFn: () => categories.list(),
  });

  const { feeds: feedList = [], category_name = "", total_unread = 0 } = data || {};

  const isSpecialCategory = selectedCategoryId === "all" || selectedCategoryId === "none";

  const handleCatMarkRead = async () => {
    setCatMenuOpen(false);
    await categories.markRead(selectedCategoryId);
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["articles"] });
  };

  const handleCatRename = async () => {
    setCatMenuOpen(false);
    const numId = parseInt(selectedCategoryId);
    if (isNaN(numId)) return;
    const newName = prompt("Rename category:", category_name);
    if (newName && newName.trim() && newName.trim() !== category_name) {
      await categories.rename(numId, newName.trim());
      qc.invalidateQueries({ queryKey: ["categories"] });
      qc.invalidateQueries({ queryKey: ["feeds", selectedCategoryId] });
    }
  };

  const handleCatDelete = async () => {
    setCatMenuOpen(false);
    const numId = parseInt(selectedCategoryId);
    if (isNaN(numId)) return;
    if (!confirm(`Delete category "${category_name}"? Feeds will become uncategorized.`)) return;
    await categories.delete(numId);
    qc.invalidateQueries({ queryKey: ["categories"] });
    handleBack();
  };

  const handleCreateCollection = async () => {
    setCatMenuOpen(false);
    const numId = parseInt(selectedCategoryId);
    if (isNaN(numId)) return;
    const name = prompt("New collection name:", category_name);
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    try {
      const subs = feedList.filter((f) => f.type === "subscription");
      if (subs.length === 0) {
        alert("No source feeds found in this category.");
        return;
      }
      const col = await collections.create({ name: trimmed, slug, category_id: numId });
      for (const sub of subs) {
        await collections.addFeed(col.id, sub.url, sub.auto_scrape);
      }
      qc.invalidateQueries({ queryKey: ["collections"] });
      alert(`Collection "${trimmed}" created with ${subs.length} feed${subs.length !== 1 ? "s" : ""}.`);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleMarkRead = async (feedId: string) => {
    setMenuOpenId(null);
    await feeds.markRead(feedId);
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["articles"] });
  };

  const handleDeleteSub = async (feed: FeedItem) => {
    setMenuOpenId(null);
    if (!confirm(`Remove "${feed.name}"?`)) return;
    await subscriptions.delete(feed.db_id);
    qc.invalidateQueries({ queryKey: ["feeds", selectedCategoryId] });
    qc.invalidateQueries({ queryKey: ["categories"] });
  };

  const handleToggleScrape = async (feed: FeedItem) => {
    setMenuOpenId(null);
    await subscriptions.toggleScrape(feed.db_id);
    qc.invalidateQueries({ queryKey: ["feeds", selectedCategoryId] });
    qc.invalidateQueries({ queryKey: ["articles"] });
  };

  const handleChangeCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!changeCatFeedId) return;
    const catId = targetCatId && targetCatId !== "none" ? parseInt(targetCatId) : null;
    await subscriptions.changeCategory(changeCatFeedId.db_id, catId);
    setChangeCatFeedId(null);
    qc.invalidateQueries({ queryKey: ["feeds", selectedCategoryId] });
    qc.invalidateQueries({ queryKey: ["categories"] });
  };

  if (isLoading) {
    return <div className="flex items-center justify-center py-12"><div className="spinner" /></div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Sub-header with category context menu */}
      <div className="shrink-0 glass sticky top-0 border-b border-white/8 px-3 py-2 flex items-center gap-2 z-10">
        <button onClick={handleBack} className="p-1.5 rounded-lg text-muted hover:text-fg hover:bg-white/8 transition-all">
          <ArrowLeft size={18} />
        </button>
        <span className="font-semibold text-sm flex-1 truncate">{category_name}</span>
        <div className="relative">
          <button
            onClick={() => setCatMenuOpen(!catMenuOpen)}
            className="p-1.5 rounded-lg text-muted hover:text-fg hover:bg-white/8 transition-all"
          >
            <MoreVertical size={18} />
          </button>
          {catMenuOpen && (
            <div className="absolute right-0 top-8 w-48 glass-heavy rounded-xl shadow-2xl py-1 z-50 text-sm">
              <button
                onClick={handleCatMarkRead}
                className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-white/8 transition-colors"
              >
                <CheckCheck size={14} /> Mark All Read
              </button>
              {!isSpecialCategory && (
                <>
                  <button
                    onClick={handleCatRename}
                    className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-white/8 transition-colors"
                  >
                    <Pencil size={14} /> Rename Category
                  </button>
                  <button
                    onClick={handleCreateCollection}
                    className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-white/8 transition-colors"
                  >
                    <Layers size={14} /> Create Collection
                  </button>
                  <button
                    onClick={handleCatDelete}
                    className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-white/8 transition-colors text-danger"
                  >
                    <Trash2 size={14} /> Delete Category
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
      <div className="tile-grid">
        {/* All articles in category */}
        <button
          onClick={() => selectFeed("__all__")}
          className={`flex flex-col items-start p-3 rounded-xl border transition-all text-left glass-card ${
            selectedFeedId === "__all__"
              ? "border-primary/60 bg-primary/10 shadow-[0_0_12px_rgb(var(--primary)/0.2)]"
              : "border-transparent bg-primary/5 hover:bg-primary/10"
          }`}
        >
          <span className="font-medium text-sm">All Articles Here</span>
          {total_unread > 0 && (
            <span className="mt-1.5 text-xs font-bold text-primary">{total_unread}</span>
          )}
        </button>

        {feedList.map((feed) => (
          <div key={feed.id} className="relative">
            <button
              onClick={() => selectFeed(feed.id)}
              className={`w-full flex flex-col items-start p-3 rounded-xl border transition-all text-left glass-card ${
                selectedFeedId === feed.id
                  ? "border-primary/60 bg-primary/10 shadow-[0_0_12px_rgb(var(--primary)/0.2)]"
                  : feed.type === "collection"
                  ? "border-transparent bg-primary/5 hover:bg-primary/10"
                  : "border-transparent hover:bg-white/8"
              }`}
            >
              <span className="font-medium text-sm line-clamp-2">
                {feed.type === "collection" ? "✨ " : ""}{feed.name}
              </span>
              {feed.keywords.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {feed.keywords.slice(0, 2).map((kw) => (
                    <span key={kw} className="text-xs bg-white/10 px-1.5 py-0.5 rounded text-muted">{kw}</span>
                  ))}
                  {feed.keywords.length > 2 && (
                    <span className="text-xs text-muted">+{feed.keywords.length - 2}</span>
                  )}
                </div>
              )}
              {feed.unread_count > 0 && (
                <span className="mt-1.5 text-xs font-bold text-primary">{feed.unread_count}</span>
              )}
            </button>
            <div className="absolute top-1.5 right-1.5">
              <button
                onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === feed.id ? null : feed.id); }}
                className="p-1 rounded text-muted hover:text-white"
              >
                <MoreVertical size={14} />
              </button>
              {menuOpenId === feed.id && (
                <div className="absolute right-0 top-6 w-44 glass-heavy rounded-xl shadow-2xl py-1 z-50 text-sm">
                  <button onClick={() => { setMenuOpenId(null); handleMarkRead(feed.id); }} className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-white/8 transition-colors">
                    <CheckCheck size={14} /> Mark Read
                  </button>
                  {feed.type === "subscription" && (
                    <>
                      <button onClick={() => handleToggleScrape(feed)} className={`flex items-center gap-2 w-full px-3 py-1.5 hover:bg-white/8 transition-colors ${feed.auto_scrape ? "text-primary" : ""}`}>
                        <ScanText size={14} /> {feed.auto_scrape ? "Auto-Scrape: On" : "Auto-Scrape: Off"}
                      </button>
                      <button onClick={() => { setMenuOpenId(null); setChangeCatFeedId(feed); setTargetCatId("none"); }} className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-white/8 transition-colors">
                        <FolderInput size={14} /> Change Category
                      </button>
                      <button onClick={() => handleDeleteSub(feed)} className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-white/8 transition-colors text-danger">
                        <Trash2 size={14} /> Delete Feed
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      </div>

      {/* Change category modal */}
      {changeCatFeedId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="glass-heavy rounded-2xl p-6 w-full max-w-sm">
            <h2 className="font-semibold mb-4">Change Category</h2>
            <form onSubmit={handleChangeCategory} className="space-y-3">
              <select
                value={targetCatId}
                onChange={(e) => setTargetCatId(e.target.value)}
                className="w-full bg-background/60 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary transition-colors"
              >
                <option value="none">-- Uncategorized --</option>
                {catsData?.categories.map((c) => (
                  <option key={c.id} value={String(c.id)}>{c.name}</option>
                ))}
              </select>
              <div className="flex gap-2">
                <button type="button" onClick={() => setChangeCatFeedId(null)} className="flex-1 py-2 rounded-lg text-sm hover:bg-white/8 transition-colors">Cancel</button>
                <button type="submit" className="flex-1 py-2 rounded-lg bg-primary text-sm font-medium hover:bg-primary-hover transition-all hover:shadow-[0_0_16px_rgb(var(--primary)/0.35)]">Move</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Click outside menus */}
      {(menuOpenId || catMenuOpen) && (
        <div className="fixed inset-0 z-30" onClick={() => { setMenuOpenId(null); setCatMenuOpen(false); }} />
      )}
    </div>
  );
}
