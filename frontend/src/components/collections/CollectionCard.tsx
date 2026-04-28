"use client";

import { useQueryClient } from "@tanstack/react-query";
import { collections, type Collection } from "@/lib/api";
import { MoreVertical, Trash2, Pencil, Play, ToggleLeft, ToggleRight } from "lucide-react";
import { useState } from "react";
import CollectionModal from "./CollectionModal";

interface Props {
  collection: Collection;
  allCategories: { id: number; name: string }[];
}

export default function CollectionCard({ collection: col, allCategories }: Props) {
  const qc = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const handleToggleActive = async () => {
    setMenuOpen(false);
    await collections.toggleActive(col.id);
    qc.invalidateQueries({ queryKey: ["collections"] });
  };

  const handleTrigger = async () => {
    setMenuOpen(false);
    await collections.trigger(col.id);
    qc.invalidateQueries({ queryKey: ["collections"] });
  };

  const handleDelete = async () => {
    setMenuOpen(false);
    if (!confirm(`Delete "${col.name}"? This cannot be undone.`)) return;
    await collections.delete(col.id);
    qc.invalidateQueries({ queryKey: ["collections"] });
  };

  const statusColors: Record<string, string> = {
    pending: "text-muted bg-white/5",
    generating: "text-warning bg-warning/10 animate-pulse",
    done: "text-success bg-success/10",
  };

  return (
    <>
      <div
        className={`relative glass-card rounded-2xl p-4 transition-all ${
          col.is_active ? "hover:shadow-[0_0_20px_rgb(var(--primary)/0.15)]" : "opacity-60"
        }`}
      >
        {/* Enable toggle */}
        <button
          onClick={handleToggleActive}
          className={`absolute left-3 top-3 transition-colors ${col.is_active ? "text-primary" : "text-muted"}`}
          title={col.is_active ? "Disable" : "Enable"}
        >
          {col.is_active ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
        </button>

        {/* Menu */}
        <div className="absolute top-2 right-2">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-1.5 rounded-lg text-muted hover:text-fg hover:bg-white/8 transition-all"
          >
            <MoreVertical size={16} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-7 w-44 glass-heavy rounded-xl shadow-2xl py-1 z-50 text-sm">
              <button onClick={handleTrigger} className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-white/8 transition-colors">
                <Play size={13} /> Summarize Now
              </button>
              <button onClick={() => { setMenuOpen(false); setModalOpen(true); }} className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-white/8 transition-colors">
                <Pencil size={13} /> Edit
              </button>
              <button onClick={handleDelete} className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-white/8 transition-colors text-danger">
                <Trash2 size={13} /> Delete
              </button>
            </div>
          )}
        </div>

        {/* Content — clickable to open modal */}
        <div className="pl-8 pr-6 cursor-pointer" onClick={() => setModalOpen(true)}>
          <h3 className="font-semibold text-sm mb-0.5 truncate">{col.name}</h3>
          <p className="text-xs text-muted font-mono mb-2">{col.slug}</p>

          {/* Keywords */}
          {col.keywords_list.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {col.keywords_list.slice(0, 3).map((kw) => (
                <span key={kw} className="text-xs bg-white/10 text-muted px-1.5 py-0.5 rounded">{kw}</span>
              ))}
              {col.keywords_list.length > 3 && (
                <span className="text-xs text-muted">+{col.keywords_list.length - 3}</span>
              )}
            </div>
          )}

          {/* Status */}
          <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[col.status_type]}`}>
            {col.status_text}
          </span>
        </div>
      </div>

      {/* Menu backdrop */}
      {menuOpen && <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />}

      {/* Collection modal */}
      {modalOpen && (
        <CollectionModal
          collection={col}
          onClose={() => setModalOpen(false)}
          allCategories={allCategories}
        />
      )}
    </>
  );
}
