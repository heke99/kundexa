import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  outputFileTracingExcludes: {
    "*": ["./node_modules/next/**/*", "./node_modules/typescript/**/*", "./node_modules/@types/**/*"],
  },
  reactStrictMode: true,
  poweredByHeader: false,
  // Type checking is executed explicitly by `npm run typecheck` before builds.
  // Avoid running a second hanging checker inside constrained CI runners.
  typescript: { ignoreBuildErrors: true },
  experimental: {
    cpus: 1,
    workerThreads: false,
    webpackBuildWorker: false,
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
        ],
      },
    ];
  },
};

export default nextConfig;
