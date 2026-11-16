import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The catalog JSON payload for a single term is ~2.5MB; give server actions room.
  experimental: {
    serverActions: { bodySizeLimit: "6mb" },
  },
  // node:sqlite is a built-in Node module; never try to bundle it.
  serverExternalPackages: [],
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
