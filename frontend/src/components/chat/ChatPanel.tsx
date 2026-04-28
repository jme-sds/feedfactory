"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { chat, type ChatConversation, type ChatMessage, type Article } from "@/lib/api";
import { useChatStore } from "@/lib/store";
import ChatHeader from "./ChatHeader";
import ChatSettingsPanel from "./ChatSettingsPanel";
import MessageList from "./MessageList";
import ChatInputBar from "./ChatInputBar";

interface Props {
  conversation: ChatConversation;
  showBack?: boolean;
  className?: string;
}

export default function ChatPanel({ conversation, showBack = false, className = "" }: Props) {
  const qc = useQueryClient();
  const { goBackInChat, openArticleFromChat } = useChatStore();
  const [sending, setSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Optimistic messages appended before server response
  const [optimisticMessages, setOptimisticMessages] = useState<ChatMessage[]>([]);

  const { data: serverMessages = [] } = useQuery({
    queryKey: ["chat-messages", conversation.id],
    queryFn: () => chat.getMessages(conversation.id),
    staleTime: 0,
  });

  // Merge server messages with any pending optimistic ones
  const allMessages = [...serverMessages, ...optimisticMessages.filter(
    (om) => !serverMessages.some((sm) => sm.id === om.id)
  )];

  const handleSend = async (content: string) => {
    if (sending) return;
    setSending(true);

    // Optimistic user message
    const tempUserMsg: ChatMessage = {
      id: -Date.now(),
      role: "user",
      content,
      created_at: new Date().toISOString(),
      retrieved_article_ids: [],
    };
    setOptimisticMessages((prev) => [...prev, tempUserMsg]);

    try {
      const assistantMsg = await chat.sendMessage(conversation.id, content);
      // Invalidate to get both messages from server
      await qc.invalidateQueries({ queryKey: ["chat-messages", conversation.id] });
      setOptimisticMessages([]);

      // Auto-rename if still default title and this is the first exchange
      if (conversation.title === "New Conversation" && serverMessages.length === 0) {
        chat.renameAI(conversation.id)
          .then(() => qc.invalidateQueries({ queryKey: ["chat-conversations"] }))
          .catch(() => {});
      }

      // Mark conversation as updated
      qc.invalidateQueries({ queryKey: ["chat-conversations"] });
    } catch (err) {
      // Remove optimistic message on failure
      setOptimisticMessages([]);
      console.error("[Chat] Send failed:", err);
    } finally {
      setSending(false);
    }
  };

  // Get the current conversation data (may be stale from prop; re-read from cache)
  const { data: conversations = [] } = useQuery({
    queryKey: ["chat-conversations"],
    queryFn: chat.listConversations,
    staleTime: 5_000,
  });
  const liveConv = conversations.find((c) => c.id === conversation.id) ?? conversation;

  return (
    <div className={`flex flex-col h-full min-h-0 ${className}`}>
      <ChatHeader
        conversation={liveConv}
        settingsOpen={settingsOpen}
        onSettingsToggle={() => setSettingsOpen((o) => !o)}
        showBack={showBack}
        onBack={goBackInChat}
      />
      {settingsOpen && <ChatSettingsPanel conversation={liveConv} />}
      <MessageList
        messages={allMessages}
        sending={sending}
        onArticleClick={openArticleFromChat}
      />
      <ChatInputBar onSend={handleSend} disabled={sending} />
    </div>
  );
}
