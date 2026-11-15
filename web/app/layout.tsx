import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { LangProvider } from "@/components/lang";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "work.jobs", template: "%s · work.jobs" },
  description:
    "Ausbildung and job postings from the Bundesagentur für Arbeit, Arbeitnow, Remotive, Jobicy, Remote OK, Himalayas, Working Nomads and Landing.jobs, refreshed every 6 hours.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <LangProvider>
          <SiteHeader />
          {children}
        </LangProvider>
      </body>
    </html>
  );
}
