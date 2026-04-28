"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { categories, collections, topicTags, entities, type Category, type TopicTag, type EntityStat } from "@/lib/api";
import { useReaderStore } from "@/lib/store";
import { MoreVertical, Trash2, Pencil, Plus, CheckCheck, Star, Layers } from "lucide-react";
import { useState } from "react";

export default function CategoryGrid() {
  const qc = useQueryClient();
  const { selectCategory, selectedCategoryId, tagBrowseMode, selectedTagFilter, selectTagFilter, selectedEntityFilter, selectEntityFilter } = useReaderStore();
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["categories"],
    queryFn: categories.list,
    refetchInterval: 60_000,
  });

  const { data: tagList = [] } = useQuery({
    queryKey: ["topic-tags"],
    queryFn: topicTags.list,
    enabled: tagBrowseMode,
  });

  const { data: entityList = [] } = useQuery({
    queryKey: ["entities-popular"],
    queryFn: () => entities.popular(150),
    enabled: tagBrowseMode,
    staleTime: 5 * 60_000,
  });

  const handleMarkRead = async (id: string) => {
    setMenuOpenId(null);
    await categories.markRead(id);
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["articles"] });
  };

  const handleRename = async (cat: Category) => {
    setMenuOpenId(null);
    const newName = prompt("Rename category:", cat.name);
    if (newName && newName.trim() && newName.trim() !== cat.name) {
      await categories.rename(cat.id, newName.trim());
      qc.invalidateQueries({ queryKey: ["categories"] });
    }
  };

  const handleDelete = async (cat: Category) => {
    setMenuOpenId(null);
    if (!confirm(`Delete category "${cat.name}"? Feeds will become uncategorized.`)) return;
    await categories.delete(cat.id);
    qc.invalidateQueries({ queryKey: ["categories"] });
  };

  const handleCreateCollection = async (cat: Category) => {
    setMenuOpenId(null);
    const name = prompt("New collection name:", cat.name);
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    try {
      const feedsData = await categories.feeds(String(cat.id));
      const subs = feedsData.feeds.filter((f) => f.type === "subscription");
      if (subs.length === 0) {
        alert("No source feeds found in this category.");
        return;
      }
      const col = await collections.create({ name: trimmed, slug, category_id: cat.id });
      for (const sub of subs) {
        await collections.addFeed(col.id, sub.url, sub.auto_scrape);
      }
      qc.invalidateQueries({ queryKey: ["collections"] });
      alert(`Collection "${trimmed}" created with ${subs.length} feed${subs.length !== 1 ? "s" : ""}.`);
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (isLoading && !tagBrowseMode) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="spinner" />
      </div>
    );
  }

  // Tag browse mode: show TopicTag tiles then entity tiles
  if (tagBrowseMode) {
    const activeTags = tagList.filter((t) => t.is_active);
    return (
      <div className="tile-grid">
        {activeTags.length === 0 && entityList.length === 0 && (
          <p className="col-span-full text-xs text-muted text-center py-8">
            No active topic tags. Add tags in Settings.
          </p>
        )}
        {activeTags.map((tag) => (
          <TagTile
            key={tag.id}
            tag={tag}
            isSelected={selectedTagFilter === tag.name && !selectedEntityFilter}
            onClick={() => selectTagFilter(selectedTagFilter === tag.name ? null : tag.name)}
          />
        ))}
        {entityList.map((ent) => (
          <EntityTile
            key={ent.text}
            entity={ent}
            isSelected={selectedEntityFilter === ent.text}
            onClick={() => selectEntityFilter(selectedEntityFilter === ent.text ? null : ent.text)}
          />
        ))}
      </div>
    );
  }

  const { categories: cats = [], total_unread = 0, uncategorized_unread = 0, has_uncategorized = false, newest_ts_all = 0, favorites_count = 0, favorites_unread = 0 } = data || {};

  const allTile = { id: "all", name: "All Feeds", unread_count: total_unread, newest_ts: newest_ts_all };
  const aiDigest = cats.find((c) => c.name === "AI Digest");
  const regularCats = cats.filter((c) => c.name !== "AI Digest");

  const Tile = ({ id, name, unread, isActive }: { id: string; name: string; unread: number; isActive: boolean }) => (
    <button
      onClick={() => selectCategory(id)}
      className={`relative flex flex-col items-start p-3 rounded-xl border transition-all text-left glass-card ${
        isActive
          ? "border-primary/60 bg-primary/10 shadow-[0_0_12px_rgb(var(--primary)/0.2)]"
          : "border-transparent hover:bg-white/8"
      }`}
    >
      <span className="font-medium text-sm line-clamp-2">{name}</span>
      {unread > 0 && (
        <span className="mt-1.5 text-xs font-bold text-primary">{unread}</span>
      )}
    </button>
  );

  return (
    <div className="tile-grid">
      {/* All Feeds */}
      <Tile id="all" name="All Feeds" unread={total_unread} isActive={selectedCategoryId === "all"} />

      {/* Favorites tile */}
      {favorites_count > 0 && (
        <button
          onClick={() => selectCategory("favorites")}
          className={`relative flex flex-col items-start p-3 rounded-xl border transition-all text-left glass-card ${
            selectedCategoryId === "favorites"
              ? "border-yellow-400/60 bg-yellow-400/10 shadow-[0_0_12px_rgb(250_204_21/0.25)]"
              : "border-transparent bg-yellow-400/5 hover:bg-yellow-400/10"
          }`}
        >
          <div className="flex items-center gap-1.5">
            <Star size={13} className="text-yellow-400" fill="currentColor" />
            <span className="font-medium text-sm">Favorites</span>
          </div>
          {favorites_unread > 0 && (
            <span className="mt-1.5 text-xs font-bold text-yellow-400">{favorites_unread}</span>
          )}
        </button>
      )}

      {/* AI Digest pinned tile */}
      {aiDigest && (
        <div className="relative">
          <button
            onClick={() => selectCategory(String(aiDigest.id))}
            className={`w-full flex flex-col items-start p-3 rounded-xl border transition-all text-left glass-card ${
              selectedCategoryId === String(aiDigest.id)
                ? "border-primary/60 bg-primary/10 shadow-[0_0_12px_rgb(var(--primary)/0.2)]"
                : "border-transparent bg-primary/5 hover:bg-primary/10"
            }`}
          >
            <span className="font-medium text-sm">✨ {aiDigest.name}</span>
            {aiDigest.unread_count > 0 && (
              <span className="mt-1.5 text-xs font-bold text-primary">{aiDigest.unread_count}</span>
            )}
          </button>
          <div className="absolute top-1.5 right-1.5">
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === `cat-${aiDigest.id}` ? null : `cat-${aiDigest.id}`); }}
              className="p-1 rounded text-muted hover:text-white"
            >
              <MoreVertical size={14} />
            </button>
            {menuOpenId === `cat-${aiDigest.id}` && (
              <CategoryMenu cat={aiDigest} onMarkRead={() => handleMarkRead(String(aiDigest.id))} onRename={() => handleRename(aiDigest)} onDelete={() => handleDelete(aiDigest)} onCreateCollection={() => handleCreateCollection(aiDigest)} />
            )}
          </div>
        </div>
      )}

      {/* Regular categories */}
      {regularCats.map((cat) => (
        <div key={cat.id} className="relative">
          <button
            onClick={() => selectCategory(String(cat.id))}
            className={`w-full flex flex-col items-start p-3 rounded-xl border transition-all text-left glass-card ${
              selectedCategoryId === String(cat.id)
                ? "border-primary/60 bg-primary/10 shadow-[0_0_12px_rgb(var(--primary)/0.2)]"
                : "border-transparent hover:bg-white/8"
            }`}
          >
            <span className="font-medium text-sm line-clamp-2">{cat.name}</span>
            {cat.unread_count > 0 && (
              <span className="mt-1.5 text-xs font-bold text-primary">{cat.unread_count}</span>
            )}
          </button>
          <div className="absolute top-1.5 right-1.5">
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === `cat-${cat.id}` ? null : `cat-${cat.id}`); }}
              className="p-1 rounded text-muted hover:text-white"
            >
              <MoreVertical size={14} />
            </button>
            {menuOpenId === `cat-${cat.id}` && (
              <CategoryMenu cat={cat} onMarkRead={() => handleMarkRead(String(cat.id))} onRename={() => handleRename(cat)} onDelete={() => handleDelete(cat)} onCreateCollection={() => handleCreateCollection(cat)} />
            )}
          </div>
        </div>
      ))}

      {/* Uncategorized */}
      {has_uncategorized && (
        <Tile id="none" name="Uncategorized" unread={uncategorized_unread} isActive={selectedCategoryId === "none"} />
      )}
    </div>
  );
}

function TagTile({ tag, isSelected, onClick }: { tag: TopicTag; isSelected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`relative flex flex-col items-start p-3 rounded-xl border transition-all text-left glass-card ${
        isSelected
          ? "border-yellow-400/60 bg-yellow-400/10 shadow-[0_0_12px_rgb(250_204_21/0.2)]"
          : "border-transparent bg-yellow-400/5 hover:bg-yellow-400/10"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-yellow-400" />
        <span className="font-medium text-sm text-yellow-200 line-clamp-2">{tag.name}</span>
      </div>
      {tag.is_ready && (
        <span className="mt-1 text-xs text-yellow-400/70">✦ personalized</span>
      )}
    </button>
  );
}

const ENTITY_LABEL_COLOR: Record<string, string> = {
  PERSON: "text-sky-300",
  ORG: "text-violet-300",
  GPE: "text-emerald-300",
};

function EntityTile({ entity, isSelected, onClick }: { entity: EntityStat; isSelected: boolean; onClick: () => void }) {
  const dotColor = entity.label === "PERSON" ? "bg-sky-400" : entity.label === "ORG" ? "bg-violet-400" : "bg-emerald-400";
  const borderSelected = entity.label === "PERSON" ? "border-sky-400/60 bg-sky-400/10" : entity.label === "ORG" ? "border-violet-400/60 bg-violet-400/10" : "border-emerald-400/60 bg-emerald-400/10";
  const borderIdle = entity.label === "PERSON" ? "border-transparent bg-sky-400/5 hover:bg-sky-400/10" : entity.label === "ORG" ? "border-transparent bg-violet-400/5 hover:bg-violet-400/10" : "border-transparent bg-emerald-400/5 hover:bg-emerald-400/10";
  return (
    <button
      onClick={onClick}
      className={`relative flex flex-col items-start p-3 rounded-xl border transition-all text-left glass-card ${isSelected ? borderSelected : borderIdle}`}
    >
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
        <span className={`font-medium text-sm line-clamp-2 ${ENTITY_LABEL_COLOR[entity.label] ?? ""}`}>{entity.text}</span>
      </div>
      <span className="mt-1 text-xs opacity-40">{entity.label}</span>
    </button>
  );
}

function CategoryMenu({ cat, onMarkRead, onRename, onDelete, onCreateCollection }: {
  cat: Category;
  onMarkRead: () => void;
  onRename: () => void;
  onDelete: () => void;
  onCreateCollection: () => void;
}) {
  return (
    <div className="absolute right-0 top-6 w-52 glass-heavy rounded-xl shadow-2xl py-1 z-50 text-sm">
      <button onClick={onMarkRead} className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-white/8 transition-colors">
        <CheckCheck size={14} /> Mark All Read
      </button>
      <button onClick={onRename} className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-white/8 transition-colors">
        <Pencil size={14} /> Rename
      </button>
      <button onClick={onCreateCollection} className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-white/8 transition-colors">
        <Layers size={14} /> Create Collection
      </button>
      <button onClick={onDelete} className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-white/8 transition-colors text-danger">
        <Trash2 size={14} /> Delete
      </button>
    </div>
  );
}
