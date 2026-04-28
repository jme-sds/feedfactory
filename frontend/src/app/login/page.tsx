"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { auth } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [demoInfo, setDemoInfo] = useState<{ demo_user?: string; demo_pass?: string } | null>(null);

  useEffect(() => {
    auth.status().then((s) => {
      if (!s.demo_mode) {
        router.replace("/");
        return;
      }
      if (s.authenticated) {
        router.replace("/");
        return;
      }
      if (s.demo_user) {
        setDemoInfo({ demo_user: s.demo_user, demo_pass: s.demo_pass });
      }
    }).catch(() => {});
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await auth.login(username, password);
      router.replace("/");
    } catch (err: any) {
      setError(err.message || "Invalid credentials");
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 relative overflow-hidden">
      {/* Ambient glow behind the card */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[400px] rounded-full bg-primary/8 blur-3xl" />
      </div>
      <div className="glass-heavy rounded-3xl p-8 w-full max-w-sm relative">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <Image src="/logo.png" alt="Feed Factory" width={48} height={48} className="invert dark:invert-0 mb-3" />
          <h1 className="text-2xl font-bold">Feed Factory</h1>
          <p className="text-muted text-sm mt-1">Demo Mode</p>
        </div>

        {/* Demo credentials hint */}
        {demoInfo && (
          <div className="mb-6 p-4 glass-card rounded-xl text-sm">
            <p className="text-muted mb-1">Demo credentials:</p>
            <p className="font-mono">
              <span className="text-muted">User: </span>
              <span className="text-primary">{demoInfo.demo_user}</span>
            </p>
            <p className="font-mono">
              <span className="text-muted">Pass: </span>
              <span className="text-primary">{demoInfo.demo_pass}</span>
            </p>
          </div>
        )}

        {/* Login form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-muted mb-1.5">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-background/60 border border-white/10 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-primary transition-colors"
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-muted mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-background/60 border border-white/10 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-primary transition-colors"
              autoComplete="current-password"
              required
            />
          </div>

          {error && (
            <p className="text-danger text-sm">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-primary text-white font-medium text-sm hover:bg-primary-hover transition-all hover:shadow-[0_0_20px_rgb(var(--primary)/0.4)] disabled:opacity-50"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
