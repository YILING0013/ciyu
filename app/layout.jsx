import "./globals.css";

export const metadata = {
  title: "词屿 · 标签词库",
  description: "Danbooru 中英文标签搜索与分类浏览",
  icons: { icon: "/favicon.svg" },
};

/**
 * 提供全站语言与基础布局。
 * @param {object} props 页面内容。
 * @returns {React.ReactNode} 中文页面外壳。
 */
export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
