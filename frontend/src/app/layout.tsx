"use client";

import "./globals.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { settings } from "@/lib/api";

function hexToRgbStr(hex: string) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b, str: `${r} ${g} ${b}` };
}

function applyAccent(hex: string) {
  const { r, g, b } = hexToRgbStr(hex);
  document.documentElement.style.setProperty("--primary", `${r} ${g} ${b}`);
  document.documentElement.style.setProperty("--primary-hover", `${Math.round(r * 0.82)} ${Math.round(g * 0.82)} ${Math.round(b * 0.82)}`);
}

function applyCustomColors(colorsJson: string) {
  try {
    const c = JSON.parse(colorsJson) as Record<string, string>;
    const map: Record<string, string> = {
      background: "--background",
      surface: "--surface",
      border: "--border",
      primary: "--primary",
      muted: "--muted",
      fg: "--fg",
    };
    for (const [key, prop] of Object.entries(map)) {
      if (c[key]) {
        document.documentElement.style.setProperty(prop, hexToRgbStr(c[key]).str);
      }
    }
    if (c.primary) {
      const { r, g, b } = hexToRgbStr(c.primary);
      document.documentElement.style.setProperty("--primary-hover", `${Math.round(r * 0.82)} ${Math.round(g * 0.82)} ${Math.round(b * 0.82)}`);
    }
  } catch {}
}

// Syncs the theme and reader typography from the backend on mount so settings
// changes on one device are reflected on all other devices.
function ThemeSync() {
  useEffect(() => {
    settings.get()
      .then((data) => {
        if (data?.ui_theme) {
          document.documentElement.setAttribute("data-theme", data.ui_theme);
          try { localStorage.setItem("ff_theme", data.ui_theme); } catch {}
        }
        if (data?.ui_accent && /^#[0-9a-fA-F]{6}$/.test(data.ui_accent)) {
          applyAccent(data.ui_accent);
          try { localStorage.setItem("ff_accent", data.ui_accent); } catch {}
        }
        if (data?.ui_theme === "custom" && data?.ui_custom_colors) {
          applyCustomColors(data.ui_custom_colors);
          try { localStorage.setItem("ff_custom_colors", data.ui_custom_colors); } catch {}
        }
        const glassOn = data?.ui_glass_mode !== false;
        document.documentElement.setAttribute("data-glass", glassOn ? "on" : "off");
        try { localStorage.setItem("ff_glass_mode", glassOn ? "on" : "off"); } catch {}
        // Apply reader typography as CSS custom properties with per-breakpoint overrides
        const dFamily = data?.reader_font_family || "system-ui, -apple-system, sans-serif";
        const dSize   = data?.reader_font_size   || "1.15rem";
        const dLh     = data?.reader_line_height  || "1.7";
        const mFamily = data?.reader_font_family_mobile || dFamily;
        const mSize   = data?.reader_font_size_mobile   || dSize;
        const mLh     = data?.reader_line_height_mobile  || dLh;
        const css = `:root{--reader-font-family:${dFamily};--reader-font-size:${dSize};--reader-line-height:${dLh}}@media(max-width:1023px){:root{--reader-font-family:${mFamily};--reader-font-size:${mSize};--reader-line-height:${mLh}}}`;
        let el = document.getElementById("ff-reader-typography") as HTMLStyleElement | null;
        if (!el) {
          el = document.createElement("style");
          el.id = "ff-reader-typography";
          document.head.appendChild(el);
        }
        el.textContent = css;
      })
      .catch(() => {});
  }, []);
  return null;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

// Inline script run synchronously before any CSS renders — prevents flash of
// wrong theme and accent color on every page load.
const ANTI_FOUC_SCRIPT = `(function(){
  try {
    var t = localStorage.getItem('ff_theme') || 'default';
    document.documentElement.setAttribute('data-theme', t);
    var gm = localStorage.getItem('ff_glass_mode');
    document.documentElement.setAttribute('data-glass', gm === 'off' ? 'off' : 'on');
    var a = localStorage.getItem('ff_accent');
    if (a && /^#[0-9a-fA-F]{6}$/.test(a)) {
      var r=parseInt(a.slice(1,3),16), g=parseInt(a.slice(3,5),16), b=parseInt(a.slice(5,7),16);
      document.documentElement.style.setProperty('--primary', r+' '+g+' '+b);
      document.documentElement.style.setProperty('--primary-hover', Math.round(r*.82)+' '+Math.round(g*.82)+' '+Math.round(b*.82));
    }
    if (t === 'custom') {
      var cc = localStorage.getItem('ff_custom_colors');
      if (cc) {
        try {
          var c = JSON.parse(cc);
          var map = {background:'--background',surface:'--surface',border:'--border',primary:'--primary',muted:'--muted',fg:'--fg'};
          for (var k in map) {
            if (c[k] && /^#[0-9a-fA-F]{6}$/.test(c[k])) {
              var rv=parseInt(c[k].slice(1,3),16), gv=parseInt(c[k].slice(3,5),16), bv=parseInt(c[k].slice(5,7),16);
              document.documentElement.style.setProperty(map[k], rv+' '+gv+' '+bv);
            }
          }
          if (c.primary && /^#[0-9a-fA-F]{6}$/.test(c.primary)) {
            var pr=parseInt(c.primary.slice(1,3),16), pg=parseInt(c.primary.slice(3,5),16), pb=parseInt(c.primary.slice(5,7),16);
            document.documentElement.style.setProperty('--primary-hover', Math.round(pr*.82)+' '+Math.round(pg*.82)+' '+Math.round(pb*.82));
          }
        } catch(e2){}
      }
    }
  } catch(e){}
})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const handleOffline = () => setOffline(true);
    const handleOnline = () => setOffline(false);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
      navigator.serviceWorker.addEventListener("message", (evt: MessageEvent) => {
        if (evt.data?.type === "SW_SERVING_FROM_CACHE") {
          setOffline(true);
          setTimeout(() => setOffline(false), 5000);
        }
      });
    }

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  return (
    <html lang="en">
      <head>
        {/* Anti-FOUC: runs synchronously before CSS to set data-theme immediately */}
        <script dangerouslySetInnerHTML={{ __html: ANTI_FOUC_SCRIPT }} />
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
        <meta name="theme-color" content="#141414" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/logo.png" />
        <title>Feed Factory</title>
      </head>
      <body className="bg-background min-h-screen">
        <QueryClientProvider client={queryClient}>
          <ThemeSync />
          {offline && (
            <div className="fixed top-0 left-0 right-0 z-50 bg-amber-700 text-white text-sm text-center py-1 px-4">
              Offline — cached version
            </div>
          )}
          {children}
        </QueryClientProvider>
      </body>
    </html>
  );
}
