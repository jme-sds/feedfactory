"use client";

import { useRef, useState } from "react";
import { SendHorizonal } from "lucide-react";

interface Props {
  onSend: (content: string) => void;
  disabled?: boolean;
}

export default function ChatInputBar({ onSend, disabled = false }: Props) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxH = 5 * 24 + 16; // ~5 lines
    el.style.height = Math.min(el.scrollHeight, maxH) + "px";
  };

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="shrink-0 glass border-t border-white/8 px-3 py-3">
      <div className="flex items-end gap-2 bg-background/60 border border-white/10 rounded-xl px-3 py-2 focus-within:border-primary/60 transition-all">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => { setValue(e.target.value); adjustHeight(); }}
          onKeyDown={handleKeyDown}
          placeholder="Ask about your news…"
          maxLength={4000}
          rows={1}
          disabled={disabled}
          className="flex-1 bg-transparent text-sm text-fg placeholder:text-muted resize-none outline-none leading-6 py-0.5 min-h-[24px] disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          className="shrink-0 p-1.5 rounded-lg text-primary hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="Send message"
        >
          {disabled ? (
            <span className="spinner" style={{ width: 18, height: 18 }} />
          ) : (
            <SendHorizonal size={18} />
          )}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted/60 text-center">
        AI responses may be inaccurate. Verify important information.
      </p>
    </div>
  );
}
