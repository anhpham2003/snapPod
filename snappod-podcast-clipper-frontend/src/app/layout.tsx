import "~/styles/globals.css";

import { type Metadata } from "next";

export const metadata: Metadata = {
  title: "SnapPod — AI Podcast Clipper",
  description:
    "Turn long-form conversations into captioned, vertical short videos.",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
