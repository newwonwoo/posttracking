/** @type {import('next').NextConfig} */
const nextConfig = {
  // Vercel 기본 Next.js 빌드 방식을 사용합니다.
  // output: 'standalone'은 자체 서버/도커 배포용이라 Vercel에서 빌드 추적 단계가 오래 걸릴 수 있어 제거합니다.
};

module.exports = nextConfig;
