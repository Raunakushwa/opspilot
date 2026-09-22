import type { NextConfig } from 'next';

// NOTE: Next bakes rewrite destinations into the build, so API_ORIGIN is a
// build-time value (passed as a Docker build arg). In production the load
// balancer performs the same split and this rewrite is unused.
//
// The browser talks to a single origin: Next serves the UI and proxies /api to
// the Fastify gateway. That keeps session cookies same-origin and makes CORS a
// defence-in-depth measure rather than a requirement. In production the same
// split is done by the load balancer.
const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Standalone output keeps the runtime image to the server bundle plus traced deps.
  output: 'standalone',
  rewrites() {
    return Promise.resolve([{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }]);
  },
};

export default nextConfig;
