import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Milestone on-call line",
  description: "After-hours maintenance call routing",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
