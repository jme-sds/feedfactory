"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { settings, type Settings } from "@/lib/api";
import TopBar from "@/components/layout/TopBar";
import BottomNav from "@/components/layout/BottomNav";
import { ChevronDown, ChevronRight, Check, Zap, Upload } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { auth } from "@/lib/api";

export default function SettingsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const [openSection, setOpenSection] = useState<string>("ai");
  const [form, setForm] = useState<Partial<Settings> & { api_key?: string; ui_theme?: string }>({});
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    auth.status().then((s) => {
      if (s.demo_mode && !s.authenticated) router.replace("/login");
    }).catch(() => {});
  }, [router]);

  const { data: currentSettings, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: settings.get,
  });

  useEffect(() => {
    if (currentSettings) {
      setForm({
        api_endpoint: currentSettings.api_endpoint,
        model_name: currentSettings.model_name,
        retention_read_days: currentSettings.retention_read_days,
        retention_unread_days: currentSettings.retention_unread_days,
        default_schedule: currentSettings.default_schedule,
        default_context_length: currentSettings.default_context_length,
        default_filter_max: currentSettings.default_filter_max,
        default_filter_age: currentSettings.default_filter_age,
        default_focus_keywords: currentSettings.default_focus_keywords,
        default_system_prompt: currentSettings.default_system_prompt,
        reader_font_family: currentSettings.reader_font_family,
        reader_font_size: currentSettings.reader_font_size,
        reader_line_height: currentSettings.reader_line_height,
        pwa_offline_limit: currentSettings.pwa_offline_limit,
        ui_theme: currentSettings.ui_theme || "default",
      });
    }
  }, [currentSettings]);

  const handleSave = async () => {
    try {
      await settings.update(form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleTestLlm = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await settings.testLlm({
        api_endpoint: form.api_endpoint,
        api_key: form.api_key,
        model_name: form.model_name,
      });
      setTestResult(result);
    } catch (e: any) {
      setTestResult({ ok: false, message: e.message });
    }
    setTesting(false);
  };

  const handleRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!confirm("This will overwrite your database. Continue?")) return;
    try {
      const result = await settings.restore(file);
      alert(result.message);
    } catch (err: any) {
      alert(err.message);
    }
    if (restoreInputRef.current) restoreInputRef.current.value = "";
  };

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const val = e.target.type === "number" ? Number(e.target.value) : e.target.value;
    setForm((f) => ({ ...f, [key]: val }));
  };

  const selectTheme = (theme: string) => {
    setForm((f) => ({ ...f, ui_theme: theme }));
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("ff_theme", theme); } catch {}
  };

  const inputClass = "w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary transition-colors";
  const labelClass = "block text-xs text-muted mb-1.5";
  const demoMode = currentSettings?.demo_mode;

  const Section = ({ id, title, children }: { id: string; title: string; children: React.ReactNode }) => (
    <div className="border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => setOpenSection(openSection === id ? "" : id)}
        className="w-full flex items-center justify-between px-4 py-3.5 bg-surface hover:bg-white/5 transition-colors text-left"
      >
        <span className="font-medium text-sm">{title}</span>
        {openSection === id ? <ChevronDown size={16} className="text-muted" /> : <ChevronRight size={16} className="text-muted" />}
      </button>
      {openSection === id && (
        <div className="px-4 py-4 space-y-4 border-t border-border bg-background/50">
          {children}
        </div>
      )}
    </div>
  );

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <TopBar />
        <div className="flex items-center justify-center flex-1">
          <div className="spinner" />
        </div>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <TopBar />

      <main className="flex-1 mt-12 mb-14 lg:mb-0 p-4 max-w-2xl mx-auto w-full">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold">Settings</h1>
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-sm font-medium hover:bg-primary-hover transition-colors"
          >
            {saved ? <><Check size={14} /> Saved</> : "Save All"}
          </button>
        </div>

        <div className="space-y-3">
          {/* AI Provider */}
          <Section id="ai" title="AI Provider (OpenAI Compatible)">
            {demoMode && (
              <p className="text-xs text-warning bg-warning/10 border border-warning/30 rounded-lg px-3 py-2">
                AI provider settings are locked in demo mode.
              </p>
            )}
            <div>
              <label className={labelClass}>Base URL</label>
              <input type="url" value={form.api_endpoint || ""} onChange={set("api_endpoint")} disabled={demoMode} className={inputClass} placeholder="https://api.openai.com/v1/chat/completions" />
            </div>
            <div>
              <label className={labelClass}>API Key {currentSettings?.api_key_is_set && <span className="text-success">(set)</span>}</label>
              <input type="password" value={form.api_key || ""} onChange={set("api_key")} disabled={demoMode} className={inputClass} placeholder="sk-..." />
            </div>
            <div>
              <label className={labelClass}>Model Name</label>
              <input type="text" value={form.model_name || ""} onChange={set("model_name")} disabled={demoMode} className={inputClass} placeholder="gpt-4o" />
            </div>
            {!demoMode && (
              <div className="flex items-center gap-3">
                <button onClick={handleTestLlm} disabled={testing} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-white/5 disabled:opacity-50">
                  <Zap size={14} /> {testing ? "Testing..." : "Test Connection"}
                </button>
                {testResult && (
                  <span className={`text-sm ${testResult.ok ? "text-success" : "text-danger"}`}>
                    {testResult.ok ? "✅" : "❌"} {testResult.message}
                  </span>
                )}
              </div>
            )}
          </Section>

          {/* Auto-Cleanup */}
          <Section id="cleanup" title="Reader Auto-Cleanup">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Keep Read Articles (days)</label>
                <input type="number" value={form.retention_read_days ?? 3} onChange={set("retention_read_days")} className={inputClass} min={1} />
              </div>
              <div>
                <label className={labelClass}>Keep Unread Articles (days)</label>
                <input type="number" value={form.retention_unread_days ?? 14} onChange={set("retention_unread_days")} className={inputClass} min={1} />
              </div>
            </div>
          </Section>

          {/* Collection Defaults */}
          <Section id="defaults" title="Collection Defaults">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Default Schedule</label>
                <input type="time" value={form.default_schedule || "06:00"} onChange={set("default_schedule")} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Max Age</label>
                <select value={form.default_filter_age || "24h"} onChange={set("default_filter_age")} className={inputClass}>
                  <option value="all">All time</option>
                  <option value="24h">Last 24h</option>
                  <option value="new">New since last run</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>Context Length (chars)</label>
                <input type="number" value={form.default_context_length ?? 200} onChange={set("default_context_length")} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Max Articles</label>
                <input type="number" value={form.default_filter_max ?? 0} onChange={set("default_filter_max")} className={inputClass} />
              </div>
            </div>
            <div>
              <label className={labelClass}>Default Focus Keywords</label>
              <input type="text" value={form.default_focus_keywords || ""} onChange={set("default_focus_keywords")} className={inputClass} placeholder="AI, tech, startups" />
            </div>
            <div>
              <label className={labelClass}>Default System Prompt</label>
              <textarea value={form.default_system_prompt || ""} onChange={set("default_system_prompt")} rows={6} className={`${inputClass} resize-none font-mono text-xs`} />
            </div>
          </Section>

          {/* Typography */}
          <Section id="typography" title="Reader Typography">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={labelClass}>Font Family</label>
                <input type="text" value={form.reader_font_family || ""} onChange={set("reader_font_family")} className={inputClass} placeholder="system-ui, sans-serif" />
              </div>
              <div>
                <label className={labelClass}>Font Size</label>
                <input type="text" value={form.reader_font_size || ""} onChange={set("reader_font_size")} className={inputClass} placeholder="1.15rem" />
              </div>
              <div>
                <label className={labelClass}>Line Height</label>
                <input type="text" value={form.reader_line_height || ""} onChange={set("reader_line_height")} className={inputClass} placeholder="1.7" />
              </div>
            </div>
            {form.reader_font_family && (
              <div
                className="p-3 bg-background border border-border rounded-lg text-sm"
                style={{
                  fontFamily: form.reader_font_family,
                  fontSize: form.reader_font_size || "1.15rem",
                  lineHeight: form.reader_line_height || "1.7",
                }}
              >
                Preview: The quick brown fox jumps over the lazy dog.
              </div>
            )}
          </Section>

          {/* Appearance / Theme */}
          <Section id="appearance" title="Appearance">
            <p className="text-xs text-muted">Choose a color scheme. Changes apply immediately.</p>
            <div className="grid grid-cols-2 gap-3">
              {([
                { id: "default", label: "Default",  sub: "Current dark",    bg: "#141414", border: "#444",    text: "#fff" },
                { id: "dark",    label: "Dark",      sub: "Deep grey",       bg: "#111111", border: "#2a2a2a", text: "#e0e0e0" },
                { id: "light",   label: "Light",     sub: "White & blue",    bg: "#f0f6fc", border: "#d0e4ef", text: "#1a1a1a" },
                { id: "sepia",   label: "Sepia",     sub: "Warm parchment",  bg: "#f4ecd8", border: "#c8b090", text: "#2c1a06" },
              ] as const).map((t) => {
                const active = (form.ui_theme || "default") === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => selectTheme(t.id)}
                    style={{
                      background: t.bg,
                      color: t.text,
                      borderColor: active ? (t.id === "light" ? "#0d7ea8" : t.id === "sepia" ? "#9a5e2a" : "#1095c1") : t.border,
                      borderWidth: active ? 2 : 1,
                    }}
                    className="rounded-xl border p-3 flex flex-col items-center gap-1.5 cursor-pointer transition-all text-sm font-medium"
                  >
                    <span className="text-xl">{t.id === "default" ? "🌙" : t.id === "dark" ? "⬛" : t.id === "light" ? "☀️" : "📜"}</span>
                    {t.label}
                    <span style={{ color: t.text, opacity: 0.6 }} className="text-xs font-normal">{t.sub}</span>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Storage & Offline */}
          <Section id="offline" title="Storage & Offline">
            <div>
              <label className={labelClass}>Offline Article Limit (10–1000)</label>
              <input type="number" value={form.pwa_offline_limit ?? 200} onChange={set("pwa_offline_limit")} className={inputClass} min={10} max={1000} />
            </div>
          </Section>

          {/* Backup & Restore */}
          {!demoMode && (
            <Section id="backup" title="Data Backup & Restore">
              <div className="flex flex-wrap gap-3">
                <button onClick={settings.backup} className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm hover:bg-white/5 transition-colors">
                  Download Backup
                </button>
                <button onClick={() => restoreInputRef.current?.click()} className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-danger/50 text-danger text-sm hover:bg-danger/5 transition-colors">
                  <Upload size={14} /> Restore Backup
                </button>
              </div>
              <input ref={restoreInputRef} type="file" accept=".db" className="hidden" onChange={handleRestore} />
              <p className="text-xs text-muted">Restoring a backup will overwrite the current database and requires a container restart.</p>
            </Section>
          )}
        </div>
      </main>

      <BottomNav />
    </div>
  );
}
