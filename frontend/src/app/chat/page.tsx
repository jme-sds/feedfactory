"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { auth, chat } from "@/lib/api";
import { useChatStore } from "@/lib/store";
import TopBar from "@/components/layout/TopBar";
import BottomNav from "@/components/layout/BottomNav";
import ConversationSidebar from "@/components/chat/ConversationSidebar";
import ChatPanel from "@/components/chat/ChatPanel";
import ChatArticlePanel from "@/components/chat/ChatArticlePanel";

export default function ChatPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  // iOS Safari scrolls the document when an input is focused, pushing the whole
  // UI up. Fix: pin the root to position:fixed and use the visualViewport API
  // to keep height and top in sync with the actual visible area.
  // - vv.height tracks the visible area (shrinks when keyboard opens)
  // - vv.offsetTop tracks how much iOS has scrolled the document; we counteract
  //   it by setting top to that value, keeping the UI visually stationary.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const el = rootRef.current;
      if (!el) return;
      el.style.height = `${vv.height}px`;
      el.style.top = `${vv.offsetTop}px`;
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  // Hide BottomNav when the keyboard is open. Using focus events is more
  // reliable than visualViewport height comparisons — on some iOS versions
  // window.innerHeight also shifts with the keyboard, making the delta
  // unreliable. The keyboard opens exactly when an input/textarea is focused.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        setKeyboardOpen(true);
      }
    };
    const onFocusOut = (e: FocusEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        setKeyboardOpen(false);
      }
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
  const {
    activeConversationId,
    setActiveConversationId,
    chatMobileView,
    chatViewingArticle,
  } = useChatStore();

  // Auth check
  useEffect(() => {
    auth.status().then((s) => {
      if (s.demo_mode && !s.authenticated) {
        router.replace("/login");
      }
    }).catch(() => {});
  }, [router]);

  const { data: conversations = [], isLoading } = useQuery({
    queryKey: ["chat-conversations"],
    queryFn: chat.listConversations,
    staleTime: 10_000,
  });

  // Auto-create or auto-select conversation
  useEffect(() => {
    if (isLoading) return;
    if (conversations.length === 0) {
      chat.createConversation().then((c) => {
        qc.invalidateQueries({ queryKey: ["chat-conversations"] });
        setActiveConversationId(c.id);
      }).catch(() => {});
    } else if (activeConversationId === null) {
      setActiveConversationId(conversations[0].id);
    }
  }, [isLoading, conversations.length]);

  const handleNew = async () => {
    try {
      const c = await chat.createConversation();
      qc.invalidateQueries({ queryKey: ["chat-conversations"] });
      setActiveConversationId(c.id);
    } catch {}
  };

  const activeConversation = conversations.find((c) => c.id === activeConversationId);

  return (
    <div ref={rootRef} className="fixed top-0 left-0 right-0 h-[100dvh] overflow-hidden flex flex-col">
      <TopBar />

      {/* ─── Mobile ─────────────────────────────────────────── */}
      <div className={`lg:hidden flex-1 overflow-hidden mt-12 ${keyboardOpen ? "" : "mb-14"}`}>
        {chatMobileView === "conversations" && (
          <ConversationSidebar
            conversations={conversations}
            onNew={handleNew}
            className="h-full w-full border-r-0"
          />
        )}
        {chatMobileView === "chat" && activeConversation && (
          <ChatPanel
            conversation={activeConversation}
            showBack={true}
            className="h-full"
          />
        )}
        {chatMobileView === "article" && chatViewingArticle && (
          <ChatArticlePanel />
        )}
      </div>

      {/* ─── Desktop ─────────────────────────────────────────── */}
      <div className="hidden lg:flex flex-row flex-1 overflow-hidden mt-12">
        <ConversationSidebar
          conversations={conversations}
          onNew={handleNew}
          className="h-full"
        />

        {activeConversation ? (
          <>
            <ChatPanel
              conversation={activeConversation}
              showBack={false}
              className={`flex-1 min-w-0 ${chatViewingArticle ? "border-r border-white/6" : ""}`}
            />
            {chatViewingArticle && (
              <div className="w-[440px] shrink-0 h-full overflow-hidden">
                <ChatArticlePanel />
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted text-sm">
            {isLoading ? (
              <span className="spinner" />
            ) : (
              "Select or start a conversation"
            )}
          </div>
        )}
      </div>

      {!keyboardOpen && <BottomNav />}
    </div>
  );
}
