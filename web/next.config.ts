import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const orch = process.env.NEXT_PUBLIC_ORCH_URL ?? "http://localhost:7200";
    return [{ source: "/api/:path*", destination: `${orch}/:path*` }];
  },
};

export default nextConfig;
