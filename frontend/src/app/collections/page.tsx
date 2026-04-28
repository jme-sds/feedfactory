"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { collections, categories, status, type Collection } from "@/lib/api";
import TopBar from "@/components/layout/TopBar";
import BottomNav from "@/components/layout/BottomNav";
import CollectionCard from "@/components/collections/CollectionCard";
import { Plus, Play, X } from "lucide-react";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { auth } from "@/lib/api";

export default function CollectionsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [newCatId, setNewCatId] = useState<string>("none");

  useEffect(() => {
    auth.status().then((s) => {
      if (s.demo_mode && !s.authenticated) router.replace("/login");
    }).catch(() => {});
  }, [router]);

  const { data: colList = [], isLoading } = useQuery({
    queryKey: ["collections"],
    queryFn: collections.list,
    refetchInterval: 5000, // Poll for generating status
  });

  const { data: catsData } = useQuery({
    queryKey: ["categories"],
    queryFn: categories.list,
  });

  const allCategories = catsData?.categories || [];

  // Auto-slug from name
  const handleNameChange = (name: string) => {
    setNewName(name);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    setNewSlug(slug);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newSlug.trim()) return;
    try {
      await collections.create({
        name: newName.trim(),
        slug: newSlug.trim(),
        category_id: newCatId !== "none" ? parseInt(newCatId) : null,
      });
      setCreateOpen(false);
      setNewName("");
      setNewSlug("");
      setNewCatId("none");
      qc.invalidateQueries({ queryKey: ["collections"] });
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleTriggerAll = async () => {
    await collections.triggerAll();
    qc.invalidateQueries({ queryKey: ["collections"] });
  };

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar />

      <main className="flex-1 mt-12 mb-14 lg:mb-0 p-4 max-w-4xl mx-auto w-full">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold">AI Digest Collections</h1>
          <div className="flex gap-2">
            <button
              onClick={handleTriggerAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-muted hover:text-fg hover:bg-white/8 transition-all"
            >
              <Play size={14} /> Run All
            </button>
            <button
              onClick={() => setCreateOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-sm font-medium hover:bg-primary-hover transition-all hover:shadow-[0_0_16px_rgb(var(--primary)/0.35)]"
            >
              <Plus size={14} /> New Collection
            </button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="spinner" />
          </div>
        ) : colList.length === 0 ? (
          <div className="text-center text-muted py-16">
            <p className="mb-4">No collections yet.</p>
            <button onClick={() => setCreateOpen(true)} className="px-4 py-2 rounded-lg bg-primary text-sm font-medium hover:bg-primary-hover">
              Create your first collection
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {colList.map((col) => (
              <CollectionCard
                key={col.id}
                collection={col}
                allCategories={allCategories}
              />
            ))}
          </div>
        )}
      </main>

      {/* Create collection modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="glass-heavy rounded-2xl p-6 w-full max-w-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold">New Collection</h2>
              <button onClick={() => setCreateOpen(false)} className="p-1 rounded-lg text-muted hover:text-fg hover:bg-white/8 transition-all"><X size={18} /></button>
            </div>
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="block text-xs text-muted mb-1">Name</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="My Daily Digest"
                  className="w-full bg-background/60 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary transition-colors"
                  autoFocus
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">Slug (URL-safe)</label>
                <input
                  type="text"
                  value={newSlug}
                  onChange={(e) => setNewSlug(e.target.value.replace(/[^a-z0-9-_]/g, ""))}
                  placeholder="my-daily-digest"
                  className="w-full bg-background/60 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary transition-colors"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">Category</label>
                <select
                  value={newCatId}
                  onChange={(e) => setNewCatId(e.target.value)}
                  className="w-full bg-background/60 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary transition-colors"
                >
                  <option value="none">-- Uncategorized --</option>
                  {allCategories.map((c) => (
                    <option key={c.id} value={String(c.id)}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setCreateOpen(false)} className="flex-1 py-2 rounded-lg text-sm hover:bg-white/8 transition-colors">Cancel</button>
                <button type="submit" className="flex-1 py-2 rounded-lg bg-primary text-sm font-medium hover:bg-primary-hover transition-all hover:shadow-[0_0_16px_rgb(var(--primary)/0.35)]">Create</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <BottomNav />
    </div>
  );
}
