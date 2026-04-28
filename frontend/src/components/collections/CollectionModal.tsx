"use client";

import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { collections, feeds, categories, type Collection, type CollectionFeed } from "@/lib/api";
import { X, Trash2, RefreshCw, Plus, Upload, Download, Check } from "lucide-react";
import { useRef } from "react";

interface Props {
  collection: Collection;
  onClose: () => void;
  allCategories: { id: number; name: string }[];
}

type Tab = "feeds" | "settings" | "prompt";

export default function CollectionModal({ collection, onClose, allCategories }: Props) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("feeds");
  const [feedList, setFeedList] = useState<CollectionFeed[]>(collection.feeds || []);
  const [newFeedUrl, setNewFeedUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Settings state
  const [scheduleTime, setScheduleTime] = useState(collection.schedule_time);
  const [contextLength, setContextLength] = useState(collection.context_length);
  const [filterMaxArticles, setFilterMaxArticles] = useState(collection.filter_max_articles);
  const [maxPerTopic, setMaxPerTopic] = useState(collection.max_articles_per_topic);
  const [filterAge, setFilterAge] = useState(collection.filter_age);
  const [focusKeywords, setFocusKeywords] = useState(collection.focus_keywords);
  const [ragTopK, setRagTopK] = useState(collection.rag_top_k);
  const [ragMinSim, setRagMinSim] = useState(collection.rag_min_similarity);
  const [ragEvictDays, setRagEvictDays] = useState(collection.rag_eviction_days);
  const [hdbscanMinClusterSize, setHdbscanMinClusterSize] = useState(collection.hdbscan_min_cluster_size);
  const [hdbscanMinSamples, setHdbscanMinSamples] = useState(collection.hdbscan_min_samples);
  const [hdbscanEpsilon, setHdbscanEpsilon] = useState(collection.hdbscan_cluster_selection_epsilon);
  const [hdbscanMethod, setHdbscanMethod] = useState(collection.hdbscan_cluster_selection_method);
  const [systemPrompt, setSystemPrompt] = useState(collection.system_prompt || "");

  useEffect(() => {
    // Load feeds if not already loaded
    if (!collection.feeds) {
      collections.getFeeds(collection.id).then(setFeedList).catch(() => {});
    }
  }, [collection.id, collection.feeds]);

  const handleAddFeed = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFeedUrl.trim()) return;
    try {
      const feed = await collections.addFeed(collection.id, newFeedUrl.trim());
      setFeedList((prev) => [...prev, feed]);
      setNewFeedUrl("");
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleDeleteFeed = async (feedId: number) => {
    await feeds.delete(feedId);
    setFeedList((prev) => prev.filter((f) => f.id !== feedId));
  };

  const handleToggleScrape = async (feedId: number) => {
    const result = await feeds.toggleScrape(feedId);
    setFeedList((prev) => prev.map((f) => f.id === feedId ? { ...f, auto_scrape: result.auto_scrape } : f));
  };

  const handleImportOpml = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const result = await collections.importOpml(collection.id, file);
      setFeedList(result.feeds);
    } catch (err: any) {
      alert(err.message);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      await collections.updateSettings(collection.id, {
        schedule_time: scheduleTime,
        context_length: contextLength,
        filter_max_articles: filterMaxArticles,
        max_articles_per_topic: maxPerTopic,
        filter_age: filterAge,
        focus_keywords: focusKeywords,
        rag_top_k: ragTopK,
        rag_min_similarity: ragMinSim,
        rag_eviction_days: ragEvictDays,
        hdbscan_min_cluster_size: hdbscanMinClusterSize,
        hdbscan_min_samples: hdbscanMinSamples,
        hdbscan_cluster_selection_epsilon: hdbscanEpsilon,
        hdbscan_cluster_selection_method: hdbscanMethod,
      } as any);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      qc.invalidateQueries({ queryKey: ["collections"] });
    } catch (e: any) {
      alert(e.message);
    }
    setSaving(false);
  };

  const handleSavePrompt = async () => {
    setSaving(true);
    try {
      await collections.updatePrompt(collection.id, systemPrompt);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      alert(e.message);
    }
    setSaving(false);
  };

  const inputClass = "w-full bg-background/60 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary transition-colors";
  const labelClass = "block text-xs text-muted mb-1";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="glass-heavy rounded-2xl w-full max-w-lg mt-8 mb-8">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/8">
          <div>
            <h2 className="font-semibold">{collection.name}</h2>
            <p className="text-xs text-muted font-mono">{collection.slug}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-muted hover:text-fg hover:bg-white/8 transition-all">
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-white/8">
          {(["feeds", "settings", "prompt"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2.5 text-sm capitalize transition-colors ${
                tab === t ? "text-primary border-b-2 border-primary" : "text-muted hover:text-fg"
              }`}
            >
              {t === "prompt" ? "System Prompt" : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="p-4">
          {tab === "feeds" && (
            <div className="space-y-3">
              <form onSubmit={handleAddFeed} className="flex gap-2">
                <input
                  type="url"
                  placeholder="Feed URL"
                  value={newFeedUrl}
                  onChange={(e) => setNewFeedUrl(e.target.value)}
                  className={`${inputClass} flex-1`}
                />
                <button type="submit" className="px-3 py-2 rounded-lg bg-primary text-sm text-white shrink-0">
                  <Plus size={16} />
                </button>
              </form>

              <div className="flex gap-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs text-muted hover:text-fg hover:border-primary/50 transition-all"
                >
                  <Upload size={13} /> Import OPML
                </button>
                <button
                  onClick={() => collections.exportOpml(collection.id)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs text-muted hover:text-fg hover:border-primary/50 transition-all"
                >
                  <Download size={13} /> Export OPML
                </button>
              </div>
              <input ref={fileInputRef} type="file" accept=".opml,application/xml,text/xml" className="hidden" onChange={handleImportOpml} />

              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {feedList.length === 0 && (
                  <p className="text-muted text-sm text-center py-4">No feeds yet</p>
                )}
                {feedList.map((feed) => (
                  <div key={feed.id} className="flex items-center gap-2 py-2 px-2 rounded-lg hover:bg-white/8 transition-colors group">
                    <span className="flex-1 text-sm text-muted truncate font-mono text-xs">{feed.url}</span>
                    <label className="flex items-center gap-1 text-xs text-muted cursor-pointer shrink-0">
                      <input
                        type="checkbox"
                        checked={feed.auto_scrape}
                        onChange={() => handleToggleScrape(feed.id)}
                        className="accent-primary"
                      />
                      Scrape
                    </label>
                    <button
                      onClick={() => handleDeleteFeed(feed.id)}
                      className="p-1 rounded text-muted hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "settings" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Schedule Time</label>
                  <input type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Article Age</label>
                  <select value={filterAge} onChange={(e) => setFilterAge(e.target.value)} className={inputClass}>
                    <option value="all">All time</option>
                    <option value="24h">Last 24h</option>
                    <option value="new">New since last run</option>
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Context Length (chars)</label>
                  <input type="number" value={contextLength} onChange={(e) => setContextLength(Number(e.target.value))} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Max Articles</label>
                  <input type="number" value={filterMaxArticles} onChange={(e) => setFilterMaxArticles(Number(e.target.value))} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Max Per Topic</label>
                  <input type="number" value={maxPerTopic} onChange={(e) => setMaxPerTopic(Number(e.target.value))} className={inputClass} />
                </div>
              </div>

              <div>
                <label className={labelClass}>Focus Keywords (comma-separated)</label>
                <input type="text" value={focusKeywords} onChange={(e) => setFocusKeywords(e.target.value)} placeholder="AI, machine learning, startups" className={inputClass} />
              </div>

              <div>
                <label className={labelClass}>RAG Settings</label>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="text-xs text-muted/70 block mb-1">Top-K</label>
                    <input type="number" value={ragTopK} onChange={(e) => setRagTopK(Number(e.target.value))} className={inputClass} />
                  </div>
                  <div>
                    <label className="text-xs text-muted/70 block mb-1">Min Similarity</label>
                    <input type="number" step="0.05" min="0" max="1" value={ragMinSim} onChange={(e) => setRagMinSim(Number(e.target.value))} className={inputClass} />
                  </div>
                  <div>
                    <label className="text-xs text-muted/70 block mb-1">Evict (days)</label>
                    <input type="number" value={ragEvictDays} onChange={(e) => setRagEvictDays(Number(e.target.value))} className={inputClass} />
                  </div>
                </div>
              </div>

              <div>
                <label className={labelClass}>Clustering (HDBSCAN)</label>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-muted/70 block mb-1">Min Cluster Size</label>
                    <input type="number" min="2" value={hdbscanMinClusterSize} onChange={(e) => setHdbscanMinClusterSize(Number(e.target.value))} className={inputClass} />
                  </div>
                  <div>
                    <label className="text-xs text-muted/70 block mb-1">Min Samples (0 = auto)</label>
                    <input type="number" min="0" value={hdbscanMinSamples} onChange={(e) => setHdbscanMinSamples(Number(e.target.value))} className={inputClass} />
                  </div>
                  <div>
                    <label className="text-xs text-muted/70 block mb-1">Selection Epsilon</label>
                    <input type="number" min="0" step="0.05" value={hdbscanEpsilon} onChange={(e) => setHdbscanEpsilon(Number(e.target.value))} className={inputClass} />
                  </div>
                  <div>
                    <label className="text-xs text-muted/70 block mb-1">Selection Method</label>
                    <select value={hdbscanMethod} onChange={(e) => setHdbscanMethod(e.target.value)} className={inputClass}>
                      <option value="eom">EOM (variable size)</option>
                      <option value="leaf">Leaf (uniform size)</option>
                    </select>
                  </div>
                </div>
              </div>

              <button
                onClick={handleSaveSettings}
                disabled={saving}
                className="w-full py-2 rounded-lg bg-primary text-sm font-medium hover:bg-primary-hover transition-all hover:shadow-[0_0_16px_rgb(var(--primary)/0.35)] disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saved ? <><Check size={15} /> Saved</> : saving ? "Saving..." : "Save Settings"}
              </button>
            </div>
          )}

          {tab === "prompt" && (
            <div className="space-y-3">
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={12}
                className={`${inputClass} resize-none font-mono text-xs`}
                placeholder="Custom system prompt..."
              />
              <button
                onClick={handleSavePrompt}
                disabled={saving}
                className="w-full py-2 rounded-lg bg-primary text-sm font-medium hover:bg-primary-hover transition-all hover:shadow-[0_0_16px_rgb(var(--primary)/0.35)] disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saved ? <><Check size={15} /> Saved</> : saving ? "Saving..." : "Save Prompt"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
