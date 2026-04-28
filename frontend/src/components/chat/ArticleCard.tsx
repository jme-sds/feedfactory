"use client";

import type { Article } from "@/lib/api";

interface Props {
  article: Article;
  onClick: (article: Article) => void;
}

export default function ArticleCard({ article, onClick }: Props) {
  const date = article.published
    ? new Date(article.published * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "";

  return (
    <button
      onClick={() => onClick(article)}
      className="text-left glass-card rounded-xl p-3 min-w-[200px] max-w-[280px] shrink-0 hover:bg-white/8 transition-all cursor-pointer group"
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <span
          className="inline-block w-2 h-2 rounded-full shrink-0"
          style={{ background: article.source_color || "#888" }}
        />
        <span className="text-xs text-muted truncate">{article.source_title}</span>
        {date && <span className="text-xs text-muted/60 ml-auto shrink-0">{date}</span>}
      </div>
      <p className="text-xs font-medium text-fg leading-snug line-clamp-3 group-hover:text-primary transition-colors">
        {article.title}
      </p>
    </button>
  );
}
