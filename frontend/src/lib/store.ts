import { create } from "zustand";
import type { Article } from "./api";

type MobileView = "categories" | "feeds" | "stream" | "article";

interface ReaderState {
  // Navigation
  selectedCategoryId: string; // "all", "none", or numeric id as string
  selectedFeedId: string | null;
  selectedArticle: Article | null;
  mobileView: MobileView;

  // Actions
  selectCategory: (id: string) => void;
  selectFeed: (id: string) => void;
  selectArticle: (article: Article | null) => void;
  goBack: () => void;
  goBackToCategories: () => void;
  setMobileView: (view: MobileView) => void;

  // UI state
  filterPanelOpen: boolean;
  setFilterPanelOpen: (open: boolean) => void;
  selectModeActive: boolean;
  setSelectModeActive: (active: boolean) => void;
  selectedArticleUrls: Set<string>;
  toggleSelectedArticle: (url: string) => void;
  clearSelection: () => void;
}

export const useReaderStore = create<ReaderState>((set, get) => ({
  selectedCategoryId: "all",
  selectedFeedId: null,
  selectedArticle: null,
  mobileView: "categories",

  selectCategory: (id) => {
    set({
      selectedCategoryId: id,
      selectedFeedId: null,
      selectedArticle: null,
      mobileView: "feeds",
      selectModeActive: false,
      selectedArticleUrls: new Set(),
    });
  },

  selectFeed: (id) => {
    set({
      selectedFeedId: id,
      selectedArticle: null,
      mobileView: "stream",
      selectModeActive: false,
      selectedArticleUrls: new Set(),
    });
  },

  selectArticle: (article) => {
    set({
      selectedArticle: article,
      mobileView: article ? "article" : "stream",
    });
  },

  goBack: () => {
    const { mobileView } = get();
    if (mobileView === "article") {
      set({ selectedArticle: null, mobileView: "stream" });
    } else if (mobileView === "stream") {
      set({ selectedFeedId: null, mobileView: "feeds" });
    } else if (mobileView === "feeds") {
      set({ selectedCategoryId: "all", mobileView: "categories" });
    }
  },

  // Desktop-only: go straight to categories without clearing article/feed
  goBackToCategories: () => set({ mobileView: "categories" }),

  setMobileView: (view) => set({ mobileView: view }),

  filterPanelOpen: false,
  setFilterPanelOpen: (open) => set({ filterPanelOpen: open }),

  selectModeActive: false,
  setSelectModeActive: (active) =>
    set({ selectModeActive: active, selectedArticleUrls: active ? get().selectedArticleUrls : new Set() }),

  selectedArticleUrls: new Set(),
  toggleSelectedArticle: (url) => {
    const next = new Set(get().selectedArticleUrls);
    if (next.has(url)) {
      next.delete(url);
    } else {
      next.add(url);
    }
    set({ selectedArticleUrls: next });
  },
  clearSelection: () => set({ selectedArticleUrls: new Set(), selectModeActive: false }),
}));

function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}
