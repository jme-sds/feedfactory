"use client";

import { useEffect, useRef } from "react";
import type { ChatMessage, Article } from "@/lib/api";
import MessageBubble from "./MessageBubble";
import TypingIndicator from "./TypingIndicator";

interface Props {
  messages: ChatMessage[];
  sending: boolean;
  onArticleClick: (article: Article) => void;
}

export default function MessageList({ messages, sending, onArticleClick }: Props) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = (smooth = true) => {
    sentinelRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "instant" });
  };

  useEffect(() => {
    scrollToBottom(true);
  }, [messages.length, sending]);

  // When the virtual keyboard opens/closes, the visual viewport resizes.
  // Scroll to bottom so the latest messages stay in view rather than
  // disappearing behind the keyboard or leaving empty space.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => scrollToBottom(false);
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  if (!messages.length && !sending) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6 py-12">
        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-primary">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-medium text-fg">Ask about your news</p>
          <p className="text-xs text-muted mt-1">
            Ask questions about articles in your feed. Enable retrieval to ground answers in your articles.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-3 space-y-0.5">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} onArticleClick={onArticleClick} />
      ))}
      {sending && <TypingIndicator />}
      <div ref={sentinelRef} className="h-1" />
    </div>
  );
}
