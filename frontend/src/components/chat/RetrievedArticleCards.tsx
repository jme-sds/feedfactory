"use client";

import { useQuery } from "@tanstack/react-query";
import { chat, type Article } from "@/lib/api";
import ArticleCard from "./ArticleCard";

interface Props {
  articleIds: number[];
  onArticleClick: (article: Article) => void;
}

export default function RetrievedArticleCards({ articleIds, onArticleClick }: Props) {
  const { data: articles = [] } = useQuery({
    queryKey: ["chat-articles", articleIds.join(",")],
    queryFn: () => chat.getArticlesByIds(articleIds),
    enabled: articleIds.length > 0,
    staleTime: 60_000,
  });

  if (!articles.length) return null;

  return (
    <div className="mt-2">
      <p className="text-xs text-muted mb-1.5 px-0.5">Sources</p>
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
        {articles.map((a) => (
          <ArticleCard key={a.id} article={a} onClick={onArticleClick} />
        ))}
      </div>
    </div>
  );
}
