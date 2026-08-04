import { Provider } from '@/components/provider';
import type { Metadata } from 'next';
import './global.css';

export const metadata: Metadata = {
  title: {
    default: 'HowCanvas 文档',
    template: '%s | HowCanvas',
  },
  description: 'HowCanvas（浩瀚画布）功能说明、操作手册、部署方式与开发文档',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
