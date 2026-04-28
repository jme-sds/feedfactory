"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, PanelLeft, MessageSquare } from "lucide-react";
import { chat, type ChatConversation } from "@/lib/api";
import { useChatStore } from "@/lib/store";
import ConversationListItem from "./ConversationListItem";

interface Props {
  conversations: ChatConversation[];
  onNew: () => void;
  className?: string;
}

export default function ConversationSidebar({ conversations, onNew, className = "" }: Props) {
  const qc = useQueryClient();
  const { activeConversationId, setActiveConversationId } = useChatStore();
  const [collapsed, setCollapsed] = useState(false);

  const handleRename = async (id: number, title: string) => {
    await chat.updateConversation(id, { title });
    qc.invalidateQueries({ queryKey: ["chat-conversations"] });
  };

  const handleRenameAI = async (id: number) => {
    try {
      await chat.renameAI(id);
      qc.invalidateQueries({ queryKey: ["chat-conversations"] });
    } catch {}
  };

  const handleDelete = async (id: number) => {
    await chat.deleteConversation(id);
    qc.invalidateQueries({ queryKey: ["chat-conversations"] });
    if (activeConversationId === id) {
      const remaining = conversations.filter((c) => c.id !== id);
      setActiveConversationId(remaining[0]?.id ?? null);
    }
  };

  if (collapsed) {
    return (
      <div className={`flex flex-col items-center gap-2 py-3 px-2 glass border-r border-white/8 w-12 shrink-0 ${className}`}>
        <button
          onClick={() => setCollapsed(false)}
          className="p-1.5 rounded-lg text-muted hover:text-fg hover:bg-white/8 transition-all"
          title="Expand sidebar"
        >
          <PanelLeft size={16} />
        </button>
        <button
          onClick={onNew}
          className="p-1.5 rounded-lg text-muted hover:text-primary hover:bg-primary/10 transition-all"
          title="New conversation"
        >
          <Plus size={16} />
        </button>
        <div className="w-px bg-white/8 my-1" />
        {conversations.slice(0, 8).map((c) => (
          <button
            key={c.id}
            onClick={() => setActiveConversationId(c.id)}
            className={`p-1.5 rounded-lg transition-all ${
              c.id === activeConversationId
                ? "text-primary bg-primary/15 shadow-[inset_0_0_0_1px_rgb(var(--primary)/0.3)]"
                : "text-muted hover:text-fg hover:bg-white/8"
            }`}
            title={c.title}
          >
            <MessageSquare size={14} />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className={`flex flex-col w-64 shrink-0 glass border-r border-white/8 ${className}`}>
      {/* Header */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-white/8">
        <span className="flex-1 text-xs font-semibold text-muted uppercase tracking-wide">Conversations</span>
        <button
          onClick={onNew}
          className="p-1.5 rounded-lg text-muted hover:text-primary hover:bg-primary/10 transition-all"
          title="New conversation"
        >
          <Plus size={15} />
        </button>
        <button
          onClick={() => setCollapsed(true)}
          className="p-1.5 rounded-lg text-muted hover:text-fg hover:bg-white/8 transition-all hidden lg:block"
          title="Collapse sidebar"
        >
          <PanelLeft size={15} />
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
        {conversations.length === 0 && (
          <p className="text-xs text-muted text-center py-6">No conversations yet</p>
        )}
        {conversations.map((conv) => (
          <ConversationListItem
            key={conv.id}
            conversation={conv}
            isActive={conv.id === activeConversationId}
            onSelect={() => setActiveConversationId(conv.id)}
            onRename={(title) => handleRename(conv.id, title)}
            onRenameAI={() => handleRenameAI(conv.id)}
            onDelete={() => handleDelete(conv.id)}
          />
        ))}
      </div>
    </div>
  );
}
