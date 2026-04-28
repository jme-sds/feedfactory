"use client";

import { ArrowLeft, SlidersHorizontal } from "lucide-react";
import type { ChatConversation } from "@/lib/api";

interface Props {
  conversation: ChatConversation;
  settingsOpen: boolean;
  onSettingsToggle: () => void;
  onBack?: () => void;
  showBack?: boolean;
}

export default function ChatHeader({
  conversation,
  settingsOpen,
  onSettingsToggle,
  onBack,
  showBack = false,
}: Props) {
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-2 glass border-b border-white/8">
      {showBack && onBack && (
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg text-muted hover:text-fg hover:bg-white/8 transition-all"
          aria-label="Back"
        >
          <ArrowLeft size={18} />
        </button>
      )}
      <h2 className="flex-1 text-sm font-medium text-fg truncate">{conversation.title}</h2>
      <button
        onClick={onSettingsToggle}
        className={`p-1.5 rounded-lg transition-all ${
          settingsOpen
            ? "text-primary bg-primary/15 shadow-[inset_0_0_0_1px_rgb(var(--primary)/0.3)]"
            : "text-muted hover:text-fg hover:bg-white/8"
        }`}
        aria-label="Chat settings"
        title="Retrieval settings"
      >
        <SlidersHorizontal size={16} />
      </button>
    </div>
  );
}
