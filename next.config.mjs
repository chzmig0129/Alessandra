/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: ["localhost:3000"],
    },
  },
  eslint: {
    // Don't fail build on lint warnings
    ignoreDuringBuilds: false,
  },
};

export default nextConfig;
