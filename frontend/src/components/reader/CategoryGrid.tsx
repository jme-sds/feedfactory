"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { categories, type Category } from "@/lib/api";
import { useReaderStore } from "@/lib/store";
import { MoreVertical, Trash2, Pencil, Plus, CheckCheck, Star } from "lucide-react";
import { useState } from "react";

export default function CategoryGrid() {
  const qc = useQueryClient();
  const { selectCategory, selectedCategoryId } = useReaderStore();
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["categories"],
    queryFn: categories.list,
    refetchInterval: 60_000,
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="spinner" />
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
      className={`relative flex flex-col items-start p-3 rounded-xl border transition-all text-left ${
        isActive
          ? "border-primary bg-primary/10"
          : "border-border bg-surface hover:border-primary/40 hover:bg-white/5"
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
          className={`relative flex flex-col items-start p-3 rounded-xl border transition-all text-left ${
            selectedCategoryId === "favorites"
              ? "border-yellow-400/60 bg-yellow-400/10"
              : "border-yellow-400/20 bg-yellow-400/5 hover:border-yellow-400/40 hover:bg-yellow-400/10"
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
            className={`w-full flex flex-col items-start p-3 rounded-xl border transition-all text-left ${
              selectedCategoryId === String(aiDigest.id)
                ? "border-primary bg-primary/10"
                : "border-primary/30 bg-primary/5 hover:border-primary/60 hover:bg-primary/10"
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
              <CategoryMenu cat={aiDigest} onMarkRead={() => handleMarkRead(String(aiDigest.id))} onRename={() => handleRename(aiDigest)} onDelete={() => handleDelete(aiDigest)} />
            )}
          </div>
        </div>
      )}

      {/* Regular categories */}
      {regularCats.map((cat) => (
        <div key={cat.id} className="relative">
          <button
            onClick={() => selectCategory(String(cat.id))}
            className={`w-full flex flex-col items-start p-3 rounded-xl border transition-all text-left ${
              selectedCategoryId === String(cat.id)
                ? "border-primary bg-primary/10"
                : "border-border bg-surface hover:border-primary/40 hover:bg-white/5"
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
              <CategoryMenu cat={cat} onMarkRead={() => handleMarkRead(String(cat.id))} onRename={() => handleRename(cat)} onDelete={() => handleDelete(cat)} />
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

function CategoryMenu({ cat, onMarkRead, onRename, onDelete }: {
  cat: Category;
  onMarkRead: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="absolute right-0 top-6 w-44 bg-surface border border-border rounded-lg shadow-xl py-1 z-50 text-sm">
      <button onClick={onMarkRead} className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-white/5">
        <CheckCheck size={14} /> Mark All Read
      </button>
      <button onClick={onRename} className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-white/5">
        <Pencil size={14} /> Rename
      </button>
      <button onClick={onDelete} className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-white/5 text-danger">
        <Trash2 size={14} /> Delete
      </button>
    </div>
  );
}
