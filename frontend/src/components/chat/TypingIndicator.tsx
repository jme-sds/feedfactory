"use client";

export default function TypingIndicator() {
  return (
    <div className="flex items-start gap-2 px-3 py-1">
      <div className="glass-card rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1.5">
        <span className="chat-typing-dot" />
        <span className="chat-typing-dot" />
        <span className="chat-typing-dot" />
      </div>
    </div>
  );
}
