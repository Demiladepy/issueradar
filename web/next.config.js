/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    BACKEND_URL: process.env.BACKEND_URL ?? 'http://localhost:3000',
    OXLO_API_KEY: process.env.OXLO_API_KEY ?? '',
    OXLO_BASE_URL: process.env.OXLO_BASE_URL ?? 'https://portal.oxlo.ai/v1',
    OXLO_MODEL: process.env.OXLO_MODEL ?? 'oxlo-1',
  },
};

export default nextConfig;
