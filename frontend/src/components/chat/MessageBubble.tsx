"use client";

import ReactMarkdown from "react-markdown";
import type { ChatMessage, Article } from "@/lib/api";
import RetrievedArticleCards from "./RetrievedArticleCards";

interface Props {
  message: ChatMessage;
  onArticleClick: (article: Article) => void;
}

export default function MessageBubble({ message, onArticleClick }: Props) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end px-3 py-1">
        <div className="max-w-[80%] bg-primary/20 border border-primary/30 rounded-2xl rounded-br-sm px-4 py-2.5 shadow-[0_2px_12px_rgb(var(--primary)/0.15)]">
          <p className="text-sm text-fg whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start px-3 py-1">
      <div className="max-w-[85%] glass-card rounded-2xl rounded-bl-sm px-4 py-2.5">
        <div className="chat-content text-sm leading-relaxed text-fg">
          <ReactMarkdown>{message.content}</ReactMarkdown>
        </div>
      </div>
      {message.retrieved_article_ids.length > 0 && (
        <div className="max-w-full w-full px-0">
          <RetrievedArticleCards
            articleIds={message.retrieved_article_ids}
            onArticleClick={onArticleClick}
          />
        </div>
      )}
    </div>
  );
}
