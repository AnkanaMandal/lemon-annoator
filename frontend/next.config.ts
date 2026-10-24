import type { NextConfig } from "next";

// The browser talks only to Next.js; /api/* is proxied to FastAPI, so no CORS setup is needed.
const backendUrl = (process.env.BACKEND_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // The floating dev badge overlaps the queue / save buttons.
  devIndicators: false,
  experimental: {
    // Listing very large buckets can take a while.
    proxyTimeout: 120_000,
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backendUrl}/api/:path*` }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
