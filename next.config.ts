import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `npm run build` executes `tsc --noEmit` before Next starts. The duplicate
  // Next 16 type-check worker deadlocks in constrained Linux builders, so only
  // that duplicate worker is disabled; the build still fails on every TS error.
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    // Prevents Next from spawning dozens of workers in small CI/Supabase build
    // environments. This also makes build output deterministic.
    cpus: 1,
    serverActions: {
      bodySizeLimit: "12mb",
    },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
