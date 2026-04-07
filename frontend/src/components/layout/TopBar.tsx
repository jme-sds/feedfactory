"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useRef } from "react";
import { BookOpen, Layers, Settings, MoreVertical, RefreshCw, Plus, Upload, Download, X } from "lucide-react";
import { articles, subscriptions } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";

export default function TopBar() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [addFeedOpen, setAddFeedOpen] = useState(false);
  const [addCategoryOpen, setAddCategoryOpen] = useState(false);
  const [feedUrl, setFeedUrl] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [syncing, setSyncing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const nav = [
    { href: "/", label: "Reader", Icon: BookOpen },
    { href: "/collections", label: "Digest", Icon: Layers },
    { href: "/settings", label: "Settings", Icon: Settings },
  ];

  const handleSync = async () => {
    setSyncing(true);
    setMenuOpen(false);
    try {
      await articles.forceSync();
      setTimeout(() => {
        qc.invalidateQueries();
        setSyncing(false);
      }, 2000);
    } catch {
      setSyncing(false);
    }
  };

  const handleAddFeed = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedUrl.trim()) return;
    try {
      await subscriptions.add(feedUrl.trim());
      setFeedUrl("");
      setAddFeedOpen(false);
      qc.invalidateQueries({ queryKey: ["categories"] });
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!categoryName.trim()) return;
    try {
      const { categories: cat } = await import("@/lib/api");
      await cat.create(categoryName.trim());
      setCategoryName("");
      setAddCategoryOpen(false);
      qc.invalidateQueries({ queryKey: ["categories"] });
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleImportOpml = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await subscriptions.importOpml(file);
      qc.invalidateQueries({ queryKey: ["categories"] });
    } catch (err: any) {
      alert(err.message);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <>
      <header className="fixed top-0 left-0 right-0 z-40 h-12 bg-surface border-b border-border flex items-center px-3 gap-3">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <Image src="/logo.svg" alt="Feed Factory" width={24} height={24} className="invert dark:invert-0" />
          <span className="font-semibold text-sm hidden sm:block">Feed Factory</span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden lg:flex items-center gap-1 ml-2">
          {nav.map(({ href, label, Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                  active
                    ? "bg-primary/20 text-primary"
                    : "text-muted hover:text-white hover:bg-white/5"
                }`}
              >
                <Icon size={16} />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="flex-1" />

        {/* Sync indicator */}
        {syncing && (
          <div className="flex items-center gap-1.5 text-muted text-xs">
            <RefreshCw size={14} className="animate-spin" />
            <span className="hidden sm:block">Syncing...</span>
          </div>
        )}

        {/* Global menu */}
        <div className="relative">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-1.5 rounded-md text-muted hover:text-white hover:bg-white/5 transition-colors"
          >
            <MoreVertical size={18} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-8 w-52 bg-surface border border-border rounded-lg shadow-xl py-1 z-50">
              <button
                onClick={() => { setAddCategoryOpen(true); setMenuOpen(false); }}
                className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-white/5"
              >
                <Plus size={15} /> Create Category
              </button>
              <button
                onClick={() => { setAddFeedOpen(true); setMenuOpen(false); }}
                className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-white/5"
              >
                <Plus size={15} /> Add Feed
              </button>
              <button
                onClick={() => { fileInputRef.current?.click(); setMenuOpen(false); }}
                className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-white/5"
              >
                <Upload size={15} /> Import Feeds (OPML)
              </button>
              <button
                onClick={() => { subscriptions.exportOpml(); setMenuOpen(false); }}
                className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-white/5"
              >
                <Download size={15} /> Export Feeds (OPML)
              </button>
              <hr className="border-border my-1" />
              <button
                onClick={handleSync}
                className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-white/5"
              >
                <RefreshCw size={15} /> Force Sync All
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".opml,application/xml,text/xml"
        className="hidden"
        onChange={handleImportOpml}
      />

      {/* Add Feed Modal */}
      {addFeedOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-surface border border-border rounded-xl p-6 w-full max-w-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold">Add Feed</h2>
              <button onClick={() => setAddFeedOpen(false)}><X size={18} /></button>
            </div>
            <form onSubmit={handleAddFeed} className="space-y-3">
              <input
                type="url"
                placeholder="https://example.com/feed.xml"
                value={feedUrl}
                onChange={(e) => setFeedUrl(e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary"
                autoFocus
              />
              <div className="flex gap-2">
                <button type="button" onClick={() => setAddFeedOpen(false)} className="flex-1 py-2 rounded-lg border border-border text-sm hover:bg-white/5">Cancel</button>
                <button type="submit" className="flex-1 py-2 rounded-lg bg-primary text-sm font-medium hover:bg-primary-hover">Add</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Category Modal */}
      {addCategoryOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-surface border border-border rounded-xl p-6 w-full max-w-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold">Create Category</h2>
              <button onClick={() => setAddCategoryOpen(false)}><X size={18} /></button>
            </div>
            <form onSubmit={handleAddCategory} className="space-y-3">
              <input
                type="text"
                placeholder="Category name"
                value={categoryName}
                onChange={(e) => setCategoryName(e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary"
                autoFocus
              />
              <div className="flex gap-2">
                <button type="button" onClick={() => setAddCategoryOpen(false)} className="flex-1 py-2 rounded-lg border border-border text-sm hover:bg-white/5">Cancel</button>
                <button type="submit" className="flex-1 py-2 rounded-lg bg-primary text-sm font-medium hover:bg-primary-hover">Create</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Click outside to close menu */}
      {menuOpen && (
        <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
      )}
    </>
  );
}
