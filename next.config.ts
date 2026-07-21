import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: path.resolve(process.cwd()),
  serverExternalPackages: ["exceljs"],
  // `npm run build` kör den kanoniska `tsc --noEmit` först och stoppar på
  // varje TypeScript-fel. Next 16:s duplicerade typkontroll låser sig i den
  // begränsade byggmiljön, så endast den andra kontrollen stängs av.
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
