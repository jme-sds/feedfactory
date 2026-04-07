"use client";

import TopBar from "@/components/layout/TopBar";
import BottomNav from "@/components/layout/BottomNav";
import CategoryGrid from "@/components/reader/CategoryGrid";
import FeedGrid from "@/components/reader/FeedGrid";
import ArticleStream from "@/components/reader/ArticleStream";
import ArticlePanel from "@/components/reader/ArticlePanel";
import { useReaderStore } from "@/lib/store";
import { useEffect } from "react";
import { auth } from "@/lib/api";
import { useRouter } from "next/navigation";

export default function ReaderPage() {
  const { mobileView, selectedArticle, selectedFeedId, goBackToCategories } = useReaderStore();
  const router = useRouter();

  useEffect(() => {
    auth.status().then((s) => {
      if (s.demo_mode && !s.authenticated) {
        router.replace("/login");
      }
    }).catch(() => {});
  }, [router]);

  const showTopBar = mobileView === "categories";

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* TopBar: always on desktop, only on category grid on mobile */}
      <div className={showTopBar ? "" : "hidden lg:block"}>
        <TopBar />
      </div>

      {/* Mobile: single-panel view driven by mobileView state */}
      <div className={`lg:hidden flex-1 overflow-hidden ${showTopBar ? "mt-12" : "mt-0"} mb-14`}>
        {mobileView === "categories" && (
          <div className="h-full overflow-y-auto">
            <CategoryGrid />
          </div>
        )}
        {mobileView === "feeds" && (
          <div className="h-full flex flex-col">
            <FeedGrid />
          </div>
        )}
        {mobileView === "stream" && (
          <div className="h-full overflow-hidden flex flex-col">
            <ArticleStream />
          </div>
        )}
        {mobileView === "article" && selectedArticle && (
          <ArticlePanel isModal={false} />
        )}
      </div>

      {/* Desktop: progressive disclosure */}
      <div className="hidden lg:flex flex-1 overflow-hidden mt-12">
        {mobileView === "categories" ? (
          // State 1: no feed drill-down — categories + (article if open, else placeholder)
          <>
            <div className="w-96 shrink-0 border-r border-border overflow-y-auto">
              <CategoryGrid />
            </div>
            <div className="flex-1 overflow-hidden">
              {selectedArticle ? (
                <ArticlePanel />
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm text-muted">Select a category to get started</p>
                </div>
              )}
            </div>
          </>
        ) : !selectedFeedId ? (
          // State 2: category selected, no feed — feeds + (article if open, else placeholder)
          <>
            <div className="w-96 shrink-0 border-r border-border overflow-hidden flex flex-col">
              <FeedGrid onBack={goBackToCategories} />
            </div>
            <div className="flex-1 overflow-hidden">
              {selectedArticle ? (
                <ArticlePanel />
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm text-muted">Select a source to view articles</p>
                </div>
              )}
            </div>
          </>
        ) : (
          // State 3+4: feed selected — feeds + stream + (article or placeholder)
          <>
            <div className="w-96 shrink-0 border-r border-border overflow-hidden flex flex-col">
              <FeedGrid onBack={goBackToCategories} />
            </div>
            <div className="w-80 shrink-0 border-r border-border overflow-hidden flex flex-col">
              <ArticleStream />
            </div>
            <div className="flex-1 overflow-hidden">
              {selectedArticle ? (
                <ArticlePanel />
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm text-muted">Select an article to read</p>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <BottomNav />
    </div>
  );
}
