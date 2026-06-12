/** @type {import('next').NextConfig} */
const nextConfig = {
  // Vercel의 파일 추적 단계(Collecting build traces) 지연 방지.
  // 서버리스 함수는 Vercel 기본 방식으로 배포합니다.
  outputFileTracing: false
};

module.exports = nextConfig;
