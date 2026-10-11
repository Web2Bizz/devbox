/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output for the Docker runner stage (apps/frontend/Dockerfile).
  output: 'standalone',
  reactStrictMode: true,
  // Next 16: Turbopack is the default bundler (dev + build both run on it;
  // scripts pass --turbopack explicitly to pin the choice). No `webpack`
  // function here — `next build` hard-fails if one is detected.
  // `experimental.turbopack` moved to top-level `turbopack` in v16.
  turbopack: {},
  // Backend API stays a separate service; no rewrites — the browser calls
  // NEXT_PUBLIC_API_URL directly (see src/api/client.ts). CORS_ORIGINS on the
  // backend must include the Next.js origin.
  async redirects() {
    return [
      {
        source: '/',
        destination: '/login',
        // 307 Temporary Redirect (not permanent — keeps POST/method, no cache).
        permanent: false,
      },
      {
        source: '/registries',
        destination: '/registry/docker',
        // Temporary (not permanent) — hub restructure, keep deep links fresh.
        permanent: false,
      },
      {
        source: '/npm',
        destination: '/registry/npm',
        // Temporary (not permanent) — hub restructure, keep deep links fresh.
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
