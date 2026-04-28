import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["react-markdown"],
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL || "http://feedfactory:8000";
    return [
      // Proxy all /api/* calls to FastAPI
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
      },
      // Proxy static file routes that stay on FastAPI
      {
        source: "/feeds/:path*",
        destination: `${backendUrl}/feeds/:path*`,
      },
      {
        source: "/manifest.json",
        destination: `${backendUrl}/manifest.json`,
      },
      {
        source: "/reader/image_proxy",
        destination: `${backendUrl}/reader/image_proxy`,
      },
      {
        source: "/status.json",
        destination: `${backendUrl}/status.json`,
      },
    ];
  },
};

export default nextConfig;
