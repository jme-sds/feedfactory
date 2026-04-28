"use client";

import { useState, useRef, useEffect } from "react";
import { MoreVertical, Pencil, Sparkles, Trash2 } from "lucide-react";
import type { ChatConversation } from "@/lib/api";

interface Props {
  conversation: ChatConversation;
  isActive: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onRenameAI: () => void;
  onDelete: () => void;
}

function relativeTime(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(isoStr).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function ConversationListItem({
  conversation,
  isActive,
  onSelect,
  onRename,
  onRenameAI,
  onDelete,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(conversation.title);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) renameInputRef.current?.focus();
  }, [renaming]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const commitRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== conversation.title) onRename(trimmed);
    setRenaming(false);
  };

  return (
    <div
      className={`relative group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors ${
        isActive
          ? "bg-primary/10 text-primary border-l-2 border-primary pl-1.5"
          : "text-muted hover:text-fg hover:bg-white/8 border-l-2 border-transparent"
      }`}
      onClick={() => !renaming && onSelect()}
    >
      {renaming ? (
        <input
          ref={renameInputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") { setRenaming(false); setRenameValue(conversation.title); }
          }}
          onClick={(e) => e.stopPropagation()}
          maxLength={200}
          className="flex-1 bg-background border border-primary/50 rounded px-2 py-0.5 text-xs text-fg outline-none"
        />
      ) : (
        <>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium truncate leading-snug">{conversation.title}</p>
            <p className="text-[10px] text-muted/70 mt-0.5">{relativeTime(conversation.updated_at)}</p>
          </div>
          {/* Context menu button — visible on hover */}
          <div
            className="opacity-0 group-hover:opacity-100 transition-opacity relative"
            ref={menuRef}
          >
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
              className="p-0.5 rounded text-muted hover:text-white"
              aria-label="Conversation options"
            >
              <MoreVertical size={14} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-6 z-50 glass-heavy rounded-xl shadow-2xl py-1 w-40">
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setRenaming(true); setRenameValue(conversation.title); }}
                  className="flex items-center gap-2 w-full px-3 py-2 text-xs text-fg hover:bg-white/8 transition-colors"
                >
                  <Pencil size={13} /> Rename
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onRenameAI(); }}
                  className="flex items-center gap-2 w-full px-3 py-2 text-xs text-fg hover:bg-white/8 transition-colors"
                >
                  <Sparkles size={13} /> AI Rename
                </button>
                <div className="border-t border-white/8 my-1" />
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(); }}
                  className="flex items-center gap-2 w-full px-3 py-2 text-xs text-red-400 hover:bg-red-400/10 transition-colors"
                >
                  <Trash2 size={13} /> Delete
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
