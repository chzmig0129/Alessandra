import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alessandra · Alcaldía Cuauhtémoc",
  description: "Asistente ciudadano de la Alcaldía Cuauhtémoc",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
