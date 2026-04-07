// Typed API client for FeedFactory FastAPI backend

function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const method = (options.method || "GET").toUpperCase();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  // Add CSRF token for mutating requests
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers["X-CSRF-Token"] = getCsrfToken();
    if (!headers["Content-Type"] && !(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }
  }

  const res = await fetch(path, { ...options, headers, credentials: "include" });

  if (res.status === 401) {
    // Redirect to login for auth errors
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      detail = err.detail || JSON.stringify(err);
    } catch {}
    throw new Error(detail);
  }

  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text() as unknown as T;
}

// --- Types ---

export interface Category {
  id: number;
  name: string;
  unread_count: number;
  newest_ts: number;
}

export interface CategoriesResponse {
  categories: Category[];
  total_unread: number;
  newest_ts_all: number;
  uncategorized_unread: number;
  has_uncategorized: boolean;
}

export interface FeedItem {
  id: string;
  name: string;
  type: "collection" | "subscription";
  db_id: number;
  url: string;
  keywords: string[];
  unread_count: number;
  auto_scrape: boolean;
}

export interface FeedsResponse {
  feeds: FeedItem[];
  category_name: string;
  total_unread: number;
}

export interface Article {
  id: number;
  ui_id: string;
  feed_id: string;
  link: string;
  title: string;
  display_body: string;
  published: number;
  published_str: string;
  source_title: string;
  source_color: string;
  is_generated: boolean;
  is_read: boolean;
  category_id: number | null;
  auto_scrape: boolean;
  has_scraped_content: boolean;
}

export interface Collection {
  id: number;
  name: string;
  slug: string;
  schedule_time: string;
  last_run: string | null;
  is_generating: boolean;
  is_active: boolean;
  category_id: number | null;
  focus_keywords: string;
  keywords_list: string[];
  context_length: number;
  filter_max_articles: number;
  filter_age: string;
  max_articles_per_topic: number;
  rag_top_k: number;
  rag_min_similarity: number;
  rag_eviction_days: number;
  system_prompt: string | null;
  status_text: string;
  status_type: "pending" | "generating" | "done";
  feeds?: CollectionFeed[];
}

export interface CollectionFeed {
  id: number;
  url: string;
  auto_scrape: boolean;
}

export interface Settings {
  api_endpoint: string;
  api_key_is_set: boolean;
  model_name: string;
  default_schedule: string;
  default_context_length: number;
  default_filter_max: number;
  default_filter_age: string;
  default_system_prompt: string;
  default_focus_keywords: string;
  retention_read_days: number;
  retention_unread_days: number;
  reader_font_family: string;
  reader_font_size: string;
  reader_line_height: string;
  pwa_offline_limit: number;
  demo_mode: boolean;
  ui_theme: string;
}

export interface AuthStatus {
  demo_mode: boolean;
  authenticated: boolean;
  demo_user?: string;
  demo_pass?: string;
}

export interface StatusEntry {
  text: string;
  status: "pending" | "generating" | "done";
}

// --- Auth ---

export const auth = {
  status: () => apiFetch<AuthStatus>("/api/auth/status"),
  login: (username: string, password: string) =>
    apiFetch<{ ok: boolean }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => apiFetch<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
};

// --- Categories ---

export const categories = {
  list: () => apiFetch<CategoriesResponse>("/api/categories"),
  create: (name: string) =>
    apiFetch<Category>("/api/categories", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  rename: (id: number, name: string) =>
    apiFetch<Category>(`/api/categories/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  delete: (id: number) =>
    apiFetch<void>(`/api/categories/${id}`, { method: "DELETE" }),
  markRead: (categoryId: string) =>
    apiFetch<void>(`/api/categories/${categoryId}/mark_read`, { method: "POST" }),
  feeds: (categoryId: string) =>
    apiFetch<FeedsResponse>(`/api/categories/${categoryId}/feeds`),
};

// --- Subscriptions ---

export const subscriptions = {
  list: () => apiFetch<{ id: number; url: string; title: string; category_id: number | null }[]>("/api/subscriptions"),
  add: (url: string, category_id?: number | null) =>
    apiFetch<{ id: number; url: string; title: string; category_id: number | null }>("/api/subscriptions", {
      method: "POST",
      body: JSON.stringify({ url, category_id }),
    }),
  changeCategory: (id: number, category_id: number | null) =>
    apiFetch<{ id: number; category_id: number | null }>(`/api/subscriptions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ category_id }),
    }),
  toggleScrape: (id: number) =>
    apiFetch<{ id: number; auto_scrape: boolean }>(`/api/subscriptions/${id}/toggle_scrape`, { method: "POST" }),
  delete: (id: number) =>
    apiFetch<void>(`/api/subscriptions/${id}`, { method: "DELETE" }),
  exportOpml: () => window.open("/api/subscriptions/export.opml"),
  importOpml: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return apiFetch<{ imported: number }>("/api/subscriptions/import_opml", {
      method: "POST",
      body: fd,
    });
  },
};

// --- Articles ---

export const articles = {
  list: (params: { category_id?: string; feed_id?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params.category_id) qs.set("category_id", params.category_id);
    if (params.feed_id) qs.set("feed_id", params.feed_id);
    if (params.limit) qs.set("limit", String(params.limit));
    return apiFetch<Article[]>(`/api/articles?${qs}`);
  },
  markRead: (url: string) =>
    apiFetch<void>("/api/articles/mark_read", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  markReadBulk: (urls: string[]) =>
    apiFetch<void>("/api/articles/mark_read_bulk", {
      method: "POST",
      body: JSON.stringify({ urls }),
    }),
  markUnread: (url: string) =>
    apiFetch<void>("/api/articles/mark_unread", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  markUnreadBulk: (urls: string[]) =>
    apiFetch<void>("/api/articles/mark_unread_bulk", {
      method: "POST",
      body: JSON.stringify({ urls }),
    }),
  summarize: (text: string) =>
    apiFetch<{ summary: string }>("/api/articles/summarize", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  summarizeBulk: (urls: string[], scrape = false) =>
    apiFetch<{ summary: string }>("/api/articles/summarize_bulk", {
      method: "POST",
      body: JSON.stringify({ urls, scrape }),
    }),
  fetchContent: (url: string) =>
    apiFetch<{ html: string }>("/api/reader/fetch_content", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  forceSync: () =>
    apiFetch<{ ok: boolean }>("/api/reader/force_sync", { method: "POST" }),
};

// --- Feeds ---

export const feeds = {
  markRead: (feedId: string) =>
    apiFetch<void>(`/api/feeds/${feedId}/mark_read`, { method: "POST" }),
  toggleScrape: (feedId: number) =>
    apiFetch<{ id: number; auto_scrape: boolean }>(`/api/feeds/${feedId}/toggle_scrape`, { method: "POST" }),
  delete: (feedId: number) =>
    apiFetch<void>(`/api/feeds/${feedId}`, { method: "DELETE" }),
};

// --- Collections ---

export const collections = {
  list: () => apiFetch<Collection[]>("/api/collections"),
  get: (id: number) => apiFetch<Collection>(`/api/collections/${id}`),
  create: (data: { name: string; slug: string; category_id?: number | null }) =>
    apiFetch<{ id: number; name: string; slug: string }>("/api/collections", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (id: number, data: { name: string; slug: string; category_id?: number | null }) =>
    apiFetch<Collection>(`/api/collections/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (id: number) =>
    apiFetch<void>(`/api/collections/${id}`, { method: "DELETE" }),
  getFeeds: (id: number) =>
    apiFetch<CollectionFeed[]>(`/api/collections/${id}/feeds`),
  addFeed: (id: number, url: string) =>
    apiFetch<CollectionFeed>(`/api/collections/${id}/feeds`, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  trigger: (id: number) =>
    apiFetch<{ ok: boolean }>(`/api/collections/${id}/trigger`, { method: "POST" }),
  triggerAll: () =>
    apiFetch<{ ok: boolean }>("/api/collections/trigger_all", { method: "POST" }),
  updateSettings: (id: number, data: Partial<Collection>) =>
    apiFetch<{ ok: boolean }>(`/api/collections/${id}/update_settings`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updatePrompt: (id: number, system_prompt: string) =>
    apiFetch<{ ok: boolean }>(`/api/collections/${id}/update_prompt`, {
      method: "POST",
      body: JSON.stringify({ system_prompt }),
    }),
  toggleActive: (id: number) =>
    apiFetch<{ id: number; is_active: boolean }>(`/api/collections/${id}/toggle_active`, { method: "POST" }),
  exportOpml: (id: number) => window.open(`/api/collections/${id}/export.opml`),
  importOpml: (id: number, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return apiFetch<{ imported: number; feeds: CollectionFeed[] }>(`/api/collections/${id}/import_opml`, {
      method: "POST",
      body: fd,
    });
  },
};

// --- Settings ---

export const settings = {
  get: () => apiFetch<Settings>("/api/settings"),
  update: (data: Partial<Settings> & { api_key?: string }) =>
    apiFetch<{ ok: boolean }>("/api/settings/update", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  testLlm: (data: { api_endpoint?: string; api_key?: string; model_name?: string }) =>
    apiFetch<{ ok: boolean; message: string }>("/api/settings/test_llm", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  backup: () => window.open("/api/settings/backup"),
  restore: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return apiFetch<{ ok: boolean; message: string }>("/api/settings/restore", {
      method: "POST",
      body: fd,
    });
  },
};

// --- Status ---

export const status = {
  get: () => apiFetch<Record<number, StatusEntry>>("/status.json"),
};
