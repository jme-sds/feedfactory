"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { settings, type Settings } from "@/lib/api";
import TopBar from "@/components/layout/TopBar";
import BottomNav from "@/components/layout/BottomNav";
import { ChevronDown, ChevronRight, Check, Zap, Upload } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { auth } from "@/lib/api";

function Section({
  id,
  title,
  openSection,
  setOpenSection,
  children,
}: {
  id: string;
  title: string;
  openSection: string;
  setOpenSection: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
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
}

export default function SettingsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const [openSection, setOpenSection] = useState<string>("ai");
  type CustomColors = { background: string; surface: string; border: string; primary: string; muted: string; fg: string };
  const DEFAULT_CUSTOM_COLORS: CustomColors = { background: "#141414", surface: "#1e1e1e", border: "#333333", primary: "#1095c1", muted: "#888888", fg: "#ffffff" };
  const [form, setForm] = useState<Partial<Settings> & { api_key?: string; ui_theme?: string; ui_accent?: string; ui_custom_colors?: string }>({});
  const [customColors, setCustomColors] = useState<CustomColors>(DEFAULT_CUSTOM_COLORS);
  const [typographyTab, setTypographyTab] = useState<"desktop" | "mobile">("desktop");
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
        reader_font_family_mobile: currentSettings.reader_font_family_mobile,
        reader_font_size_mobile: currentSettings.reader_font_size_mobile,
        reader_line_height_mobile: currentSettings.reader_line_height_mobile,
        pwa_offline_limit: currentSettings.pwa_offline_limit,
        ui_theme: currentSettings.ui_theme || "default",
        ui_accent: currentSettings.ui_accent || "",
        ui_custom_colors: currentSettings.ui_custom_colors || "",
        default_hdbscan_min_cluster_size: currentSettings.default_hdbscan_min_cluster_size ?? 3,
        default_hdbscan_min_samples: currentSettings.default_hdbscan_min_samples ?? 0,
        default_hdbscan_cluster_selection_epsilon: currentSettings.default_hdbscan_cluster_selection_epsilon ?? 0,
        default_hdbscan_cluster_selection_method: currentSettings.default_hdbscan_cluster_selection_method || "eom",
      });
      if (currentSettings.ui_custom_colors) {
        try {
          const parsed = JSON.parse(currentSettings.ui_custom_colors);
          setCustomColors((prev) => ({ ...prev, ...parsed }));
        } catch {}
      }
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
    settings.update({ ui_theme: theme }).catch(() => {});
  };

  const applyAccentToDOM = (hex: string) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    document.documentElement.style.setProperty("--primary", `${r} ${g} ${b}`);
    document.documentElement.style.setProperty("--primary-hover", `${Math.round(r * 0.82)} ${Math.round(g * 0.82)} ${Math.round(b * 0.82)}`);
  };

  const selectAccent = (hex: string) => {
    setForm((f) => ({ ...f, ui_accent: hex }));
    applyAccentToDOM(hex);
    try { localStorage.setItem("ff_accent", hex); } catch {}
    settings.update({ ui_accent: hex }).catch(() => {});
  };

  const hexToRgbStr = (hex: string) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${r} ${g} ${b}`;
  };

  const applyCustomColorsToDOM = (colors: CustomColors) => {
    const map: Record<string, string> = {
      background: "--background", surface: "--surface", border: "--border",
      primary: "--primary", muted: "--muted", fg: "--fg",
    };
    for (const [key, prop] of Object.entries(map)) {
      document.documentElement.style.setProperty(prop, hexToRgbStr(colors[key as keyof CustomColors]));
    }
    const { r, g, b } = { r: parseInt(colors.primary.slice(1,3),16), g: parseInt(colors.primary.slice(3,5),16), b: parseInt(colors.primary.slice(5,7),16) };
    document.documentElement.style.setProperty("--primary-hover", `${Math.round(r*.82)} ${Math.round(g*.82)} ${Math.round(b*.82)}`);
  };

  const updateCustomColor = (key: keyof CustomColors, hex: string) => {
    const next = { ...customColors, [key]: hex };
    setCustomColors(next);
    const json = JSON.stringify(next);
    setForm((f) => ({ ...f, ui_custom_colors: json }));
    applyCustomColorsToDOM(next);
    try { localStorage.setItem("ff_custom_colors", json); } catch {}
    settings.update({ ui_custom_colors: json }).catch(() => {});
  };

  const ACCENT_PRESETS = [
    { hex: "#1095c1", label: "Ocean" },
    { hex: "#3b82f6", label: "Blue" },
    { hex: "#6366f1", label: "Indigo" },
    { hex: "#8b5cf6", label: "Violet" },
    { hex: "#ec4899", label: "Rose" },
    { hex: "#ef4444", label: "Red" },
    { hex: "#f97316", label: "Orange" },
    { hex: "#eab308", label: "Amber" },
    { hex: "#22c55e", label: "Green" },
    { hex: "#14b8a6", label: "Teal" },
  ] as const;

  const inputClass = "w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary transition-colors";
  const labelClass = "block text-xs text-muted mb-1.5";
  const demoMode = currentSettings?.demo_mode;


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
          <Section id="ai" title="AI Provider (OpenAI Compatible)" openSection={openSection} setOpenSection={setOpenSection}>
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
          <Section id="cleanup" title="Reader Auto-Cleanup" openSection={openSection} setOpenSection={setOpenSection}>
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
          <Section id="defaults" title="Collection Defaults" openSection={openSection} setOpenSection={setOpenSection}>
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
            <div>
              <label className={labelClass}>Default Clustering (HDBSCAN)</label>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted/70 block mb-1">Min Cluster Size</label>
                  <input type="number" min="2" value={form.default_hdbscan_min_cluster_size ?? 3} onChange={set("default_hdbscan_min_cluster_size")} className={inputClass} />
                </div>
                <div>
                  <label className="text-xs text-muted/70 block mb-1">Min Samples (0 = auto)</label>
                  <input type="number" min="0" value={form.default_hdbscan_min_samples ?? 0} onChange={set("default_hdbscan_min_samples")} className={inputClass} />
                </div>
                <div>
                  <label className="text-xs text-muted/70 block mb-1">Selection Epsilon</label>
                  <input type="number" min="0" step="0.05" value={form.default_hdbscan_cluster_selection_epsilon ?? 0} onChange={set("default_hdbscan_cluster_selection_epsilon")} className={inputClass} />
                </div>
                <div>
                  <label className="text-xs text-muted/70 block mb-1">Selection Method</label>
                  <select value={form.default_hdbscan_cluster_selection_method || "eom"} onChange={set("default_hdbscan_cluster_selection_method")} className={inputClass}>
                    <option value="eom">EOM (variable size)</option>
                    <option value="leaf">Leaf (uniform size)</option>
                  </select>
                </div>
              </div>
            </div>
          </Section>

          {/* Typography */}
          <Section id="typography" title="Reader Typography" openSection={openSection} setOpenSection={setOpenSection}>
            {/* Desktop / Mobile tab switcher */}
            <div className="flex gap-1 p-1 bg-surface rounded-lg w-fit">
              {(["desktop", "mobile"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setTypographyTab(tab)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors capitalize ${
                    typographyTab === tab
                      ? "bg-primary text-white"
                      : "text-muted hover:text-white"
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            {typographyTab === "desktop" ? (
              <>
                <p className="text-xs text-muted">Applied on screens 1024 px and wider.</p>
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
                <div
                  className="p-3 bg-background border border-border rounded-lg text-sm"
                  style={{
                    fontFamily: form.reader_font_family || "system-ui, -apple-system, sans-serif",
                    fontSize: form.reader_font_size || "1.15rem",
                    lineHeight: form.reader_line_height || "1.7",
                  }}
                >
                  Preview: The quick brown fox jumps over the lazy dog.
                </div>
              </>
            ) : (
              <>
                <p className="text-xs text-muted">Applied on screens narrower than 1024 px. Leave blank to inherit desktop settings.</p>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className={labelClass}>Font Family</label>
                    <input type="text" value={form.reader_font_family_mobile || ""} onChange={set("reader_font_family_mobile")} className={inputClass} placeholder={form.reader_font_family || "inherited"} />
                  </div>
                  <div>
                    <label className={labelClass}>Font Size</label>
                    <input type="text" value={form.reader_font_size_mobile || ""} onChange={set("reader_font_size_mobile")} className={inputClass} placeholder={form.reader_font_size || "inherited"} />
                  </div>
                  <div>
                    <label className={labelClass}>Line Height</label>
                    <input type="text" value={form.reader_line_height_mobile || ""} onChange={set("reader_line_height_mobile")} className={inputClass} placeholder={form.reader_line_height || "inherited"} />
                  </div>
                </div>
                <div
                  className="p-3 bg-background border border-border rounded-lg text-sm"
                  style={{
                    fontFamily: form.reader_font_family_mobile || form.reader_font_family || "system-ui, -apple-system, sans-serif",
                    fontSize: form.reader_font_size_mobile || form.reader_font_size || "1.15rem",
                    lineHeight: form.reader_line_height_mobile || form.reader_line_height || "1.7",
                  }}
                >
                  Preview: The quick brown fox jumps over the lazy dog.
                </div>
              </>
            )}
          </Section>

          {/* Appearance / Theme */}
          <Section id="appearance" title="Appearance" openSection={openSection} setOpenSection={setOpenSection}>
            <div>
              <p className={labelClass}>Color Scheme</p>
              <p className="text-xs text-muted mb-3">Changes apply immediately.</p>
              <div className="grid grid-cols-2 gap-3">
                {([
                  { id: "default", label: "Default",  sub: "Dark grey",      bg: "#141414", surface: "#1e1e1e", border: "#333333", fg: "#ffffff" },
                  { id: "light",   label: "Light",     sub: "Bright white",   bg: "#f0f6fc", surface: "#ffffff", border: "#d0e4ef", fg: "#1a1a1a" },
                  { id: "sepia",   label: "Sepia",     sub: "Warm parchment", bg: "#f4ecd8", surface: "#ede3c8", border: "#c8b090", fg: "#2c1a06" },
                ] as const).map((t) => {
                  const active = (form.ui_theme || "default") === t.id;
                  const accent = form.ui_accent || "#1095c1";
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => selectTheme(t.id)}
                      style={{
                        background: t.bg,
                        color: t.fg,
                        borderColor: active ? accent : t.border,
                        borderWidth: active ? 2 : 1,
                      }}
                      className="rounded-xl border p-3 flex flex-col gap-2 cursor-pointer transition-all text-sm font-medium text-left"
                    >
                      <div style={{ background: t.bg, borderRadius: 5, overflow: "hidden", height: 38, display: "flex", flexDirection: "column", border: `1px solid ${t.border}` }}>
                        <div style={{ background: t.surface, height: 11, display: "flex", alignItems: "center", padding: "0 5px", gap: 3, borderBottom: `1px solid ${t.border}` }}>
                          <div style={{ width: 4, height: 4, borderRadius: "50%", background: accent }} />
                          <div style={{ flex: 1, height: 2, background: t.fg, opacity: 0.12, borderRadius: 1 }} />
                          <div style={{ width: 12, height: 4, borderRadius: 2, background: accent, opacity: 0.8 }} />
                        </div>
                        <div style={{ flex: 1, display: "flex", gap: 3, padding: "3px 4px" }}>
                          <div style={{ width: 16, background: t.surface, borderRadius: 2 }} />
                          <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 2 }}>
                            <div style={{ height: 2, background: t.fg, opacity: 0.4, borderRadius: 1, width: "75%" }} />
                            <div style={{ height: 2, background: t.fg, opacity: 0.2, borderRadius: 1, width: "55%" }} />
                            <div style={{ height: 2, background: accent, opacity: 0.75, borderRadius: 1, width: "40%" }} />
                          </div>
                        </div>
                      </div>
                      <div className="flex items-baseline justify-between">
                        <span>{t.label}</span>
                        <span style={{ color: t.fg, opacity: 0.5 }} className="text-xs font-normal">{t.sub}</span>
                      </div>
                    </button>
                  );
                })}

                {/* Custom theme card */}
                {(() => {
                  const active = (form.ui_theme || "default") === "custom";
                  const cc = customColors;
                  const accent = cc.primary;
                  return (
                    <button
                      type="button"
                      onClick={() => {
                        selectTheme("custom");
                        applyCustomColorsToDOM(cc);
                      }}
                      style={{
                        background: cc.background,
                        color: cc.fg,
                        borderColor: active ? accent : cc.border,
                        borderWidth: active ? 2 : 1,
                      }}
                      className="rounded-xl border p-3 flex flex-col gap-2 cursor-pointer transition-all text-sm font-medium text-left"
                    >
                      <div style={{ background: cc.background, borderRadius: 5, overflow: "hidden", height: 38, display: "flex", flexDirection: "column", border: `1px solid ${cc.border}` }}>
                        <div style={{ background: cc.surface, height: 11, display: "flex", alignItems: "center", padding: "0 5px", gap: 3, borderBottom: `1px solid ${cc.border}` }}>
                          <div style={{ width: 4, height: 4, borderRadius: "50%", background: accent }} />
                          <div style={{ flex: 1, height: 2, background: cc.fg, opacity: 0.12, borderRadius: 1 }} />
                          <div style={{ width: 12, height: 4, borderRadius: 2, background: accent, opacity: 0.8 }} />
                        </div>
                        <div style={{ flex: 1, display: "flex", gap: 3, padding: "3px 4px" }}>
                          <div style={{ width: 16, background: cc.surface, borderRadius: 2 }} />
                          <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 2 }}>
                            <div style={{ height: 2, background: cc.fg, opacity: 0.4, borderRadius: 1, width: "75%" }} />
                            <div style={{ height: 2, background: cc.fg, opacity: 0.2, borderRadius: 1, width: "55%" }} />
                            <div style={{ height: 2, background: accent, opacity: 0.75, borderRadius: 1, width: "40%" }} />
                          </div>
                        </div>
                      </div>
                      <div className="flex items-baseline justify-between">
                        <span>Custom</span>
                        <span style={{ color: cc.fg, opacity: 0.5 }} className="text-xs font-normal">Your colors</span>
                      </div>
                    </button>
                  );
                })()}
              </div>

              {/* Custom theme color editor */}
              {(form.ui_theme || "default") === "custom" && (
                <div className="mt-3 p-3 rounded-xl border border-border bg-surface/50 space-y-3">
                  <p className="text-xs text-muted">Customize each color. Changes apply immediately.</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                    {(
                      [
                        { key: "background", label: "Background" },
                        { key: "surface",    label: "Surface" },
                        { key: "border",     label: "Border" },
                        { key: "primary",    label: "Primary / Accent" },
                        { key: "muted",      label: "Muted text" },
                        { key: "fg",         label: "Foreground text" },
                      ] as { key: keyof CustomColors; label: string }[]
                    ).map(({ key, label }) => (
                      <div key={key} className="flex items-center gap-2">
                        <label
                          title={label}
                          style={{ position: "relative", flexShrink: 0, cursor: "pointer" }}
                          className="w-8 h-8 rounded-lg border border-border overflow-hidden"
                        >
                          <div style={{ width: "100%", height: "100%", background: customColors[key] }} />
                          <input
                            type="color"
                            value={customColors[key]}
                            onChange={(e) => updateCustomColor(key, e.target.value)}
                            style={{ position: "absolute", inset: 0, opacity: 0, width: "100%", height: "100%", cursor: "pointer" }}
                          />
                        </label>
                        <div className="flex flex-col min-w-0">
                          <span className="text-xs font-medium truncate">{label}</span>
                          <span className="text-xs text-muted font-mono">{customColors[key]}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setCustomColors(DEFAULT_CUSTOM_COLORS);
                      const json = JSON.stringify(DEFAULT_CUSTOM_COLORS);
                      setForm((f) => ({ ...f, ui_custom_colors: json }));
                      applyCustomColorsToDOM(DEFAULT_CUSTOM_COLORS);
                      try { localStorage.setItem("ff_custom_colors", json); } catch {}
                      settings.update({ ui_custom_colors: json }).catch(() => {});
                    }}
                    className="text-xs text-muted hover:text-fg transition-colors"
                  >
                    Reset to defaults
                  </button>
                </div>
              )}
            </div>

            {/* Accent Color */}
            <div>
              <p className={labelClass}>Accent Color</p>
              <p className="text-xs text-muted mb-3">Applied to buttons, links, highlights, toggles, and unread counts.</p>
              <div className="flex flex-wrap gap-2 items-center">
                {ACCENT_PRESETS.map((p) => {
                  const active = (form.ui_accent || "#1095c1") === p.hex;
                  return (
                    <button
                      key={p.hex}
                      type="button"
                      title={p.label}
                      onClick={() => selectAccent(p.hex)}
                      style={{
                        background: p.hex,
                        width: 26,
                        height: 26,
                        borderRadius: "50%",
                        outline: active ? `2px solid ${p.hex}` : "none",
                        outlineOffset: active ? 3 : 0,
                        transform: active ? "scale(1.15)" : "scale(1)",
                        opacity: active ? 1 : 0.7,
                        transition: "all 0.15s ease",
                        flexShrink: 0,
                      }}
                    />
                  );
                })}
                {/* Custom color */}
                <label
                  title="Custom color"
                  style={{ width: 26, height: 26, flexShrink: 0, position: "relative", cursor: "pointer" }}
                  className="rounded-full border border-border flex items-center justify-center hover:border-primary transition-colors"
                >
                  <span className="text-muted text-xs leading-none select-none">+</span>
                  <input
                    type="color"
                    value={form.ui_accent || "#1095c1"}
                    onChange={(e) => selectAccent(e.target.value)}
                    style={{ position: "absolute", inset: 0, opacity: 0, width: "100%", height: "100%", cursor: "pointer" }}
                  />
                </label>
              </div>
            </div>
          </Section>

          {/* Storage & Offline */}
          <Section id="offline" title="Storage & Offline" openSection={openSection} setOpenSection={setOpenSection}>
            <div>
              <label className={labelClass}>Offline Article Limit (10–1000)</label>
              <input type="number" value={form.pwa_offline_limit ?? 200} onChange={set("pwa_offline_limit")} className={inputClass} min={10} max={1000} />
            </div>
          </Section>

          {/* Backup & Restore */}
          {!demoMode && (
            <Section id="backup" title="Data Backup & Restore" openSection={openSection} setOpenSection={setOpenSection}>
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
