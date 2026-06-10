import './globals.css';

export const metadata = {
  title: '등기 배송상태 일괄조회 도구',
  description: '엑셀 업로드 후 등기번호 기반 우체국 배송상태 일괄조회 및 CSV 출력'
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
