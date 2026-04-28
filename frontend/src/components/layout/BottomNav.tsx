"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, Layers, Settings, MessageSquare } from "lucide-react";

export default function BottomNav() {
  const pathname = usePathname();

  const links = [
    { href: "/", label: "Reader", Icon: BookOpen },
    { href: "/chat", label: "Chat", Icon: MessageSquare },
    { href: "/collections", label: "Digest", Icon: Layers },
    { href: "/settings", label: "Settings", Icon: Settings },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 glass border-t border-white/8 lg:hidden">
      <div className="flex items-center justify-around h-14 safe-area-bottom">
        {links.map(({ href, label, Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`flex flex-col items-center gap-0.5 flex-1 py-2 text-xs transition-colors ${
                active ? "text-primary" : "text-muted hover:text-fg"
              }`}
            >
              <Icon size={20} strokeWidth={active ? 2.5 : 1.8} />
              <span>{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
