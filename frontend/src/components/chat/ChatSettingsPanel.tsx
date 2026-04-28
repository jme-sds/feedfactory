"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { chat, categories, type ChatConversation } from "@/lib/api";
import { Database } from "lucide-react";

interface Props {
  conversation: ChatConversation;
}

export default function ChatSettingsPanel({ conversation }: Props) {
  const qc = useQueryClient();

  const { data: catsData } = useQuery({
    queryKey: ["categories"],
    queryFn: categories.list,
    staleTime: 60_000,
  });
  const cats = (catsData?.categories ?? []).filter((c) => c.has_subscriptions);

  const updateConv = async (data: Partial<ChatConversation>) => {
    await chat.updateConversation(conversation.id, data);
    qc.invalidateQueries({ queryKey: ["chat-conversations"] });
  };

  const toggleCategory = (catId: number) => {
    const current = conversation.source_category_ids;
    const next = current.includes(catId)
      ? current.filter((id) => id !== catId)
      : [...current, catId];
    updateConv({ source_category_ids: next });
  };

  return (
    <div className="glass border-b border-white/8 px-4 py-3 space-y-3">
      {/* RAG toggle */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Database size={14} className="text-muted shrink-0" />
          <span className="text-xs font-medium text-fg">Article retrieval</span>
          <span className="text-xs text-muted">(RAG)</span>
        </div>
        <button
          onClick={() => updateConv({ rag_enabled: !conversation.rag_enabled })}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
            conversation.rag_enabled ? "bg-primary" : "bg-border"
          }`}
          role="switch"
          aria-checked={conversation.rag_enabled}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
              conversation.rag_enabled ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {/* Category filter (only when RAG is on) */}
      {conversation.rag_enabled && cats.length > 0 && (
        <div>
          <p className="text-xs text-muted mb-1.5">Search in categories</p>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => updateConv({ source_category_ids: [] })}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                conversation.source_category_ids.length === 0
                  ? "bg-primary/20 border-primary/50 text-primary"
                  : "border-white/10 text-muted hover:border-primary/40 hover:text-fg"
              }`}
            >
              All
            </button>
            {cats.map((cat) => {
              const active = conversation.source_category_ids.includes(cat.id);
              return (
                <button
                  key={cat.id}
                  onClick={() => toggleCategory(cat.id)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    active
                      ? "bg-primary/20 border-primary/50 text-primary"
                      : "border-white/10 text-muted hover:border-primary/40 hover:text-fg"
                  }`}
                >
                  {cat.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
