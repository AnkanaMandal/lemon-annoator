import type { NextConfig } from "next";

// Local development: the browser talks only to Next.js and /api/* is proxied to FastAPI.
// Production (Vercel): NEXT_PUBLIC_API_URL is set and the browser calls the API on Render directly.
const backendUrl = (process.env.BACKEND_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const directApi = Boolean(process.env.NEXT_PUBLIC_API_URL);

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
    return directApi ? [] : [{ source: "/api/:path*", destination: `${backendUrl}/api/:path*` }];
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
