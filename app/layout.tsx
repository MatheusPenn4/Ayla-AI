import type { Metadata, Viewport } from "next";
import "@fontsource-variable/oxanium";
import "@fontsource-variable/figtree";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "Setor IA — Escritório",
  description: "Escritório 3D interativo para configurar agentes de desenvolvimento e preparar demandas.",
  icons: { icon: "/favicon.svg" },
};
export const viewport: Viewport = { themeColor: "#0a0c1a", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className="dark">
      <body>{children}</body>
    </html>
  );
}
