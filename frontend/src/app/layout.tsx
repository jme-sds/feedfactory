"use client";

import "./globals.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect } from "react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

// Inline script run synchronously before any CSS renders — prevents flash of
// wrong theme on every page load.
const ANTI_FOUC_SCRIPT = `(function(){
  try {
    var t = localStorage.getItem('ff_theme') || 'default';
    document.documentElement.setAttribute('data-theme', t);
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
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#141414" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/logo.svg" />
        <title>Feed Factory</title>
      </head>
      <body className="bg-background min-h-screen">
        <QueryClientProvider client={queryClient}>
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
