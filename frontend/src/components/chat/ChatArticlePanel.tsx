"use client";

import { useEffect } from "react";
import { useReaderStore, useChatStore } from "@/lib/store";
import ArticlePanel from "@/components/reader/ArticlePanel";

export default function ChatArticlePanel() {
  const { chatViewingArticle, closeArticleFromChat } = useChatStore();
  const { selectArticle, resetNavigation } = useReaderStore();

  useEffect(() => {
    if (chatViewingArticle) {
      selectArticle(chatViewingArticle);
    }
    return () => {
      resetNavigation();
    };
  }, [chatViewingArticle]);

  if (!chatViewingArticle) return null;

  return (
    <ArticlePanel isModal={true} onBack={closeArticleFromChat} />
  );
}
