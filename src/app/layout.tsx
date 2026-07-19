import type { Metadata } from "next";
import "./globals.css";
import "./dialer.css";

export const metadata: Metadata = {
  title: { default: "Kundexa", template: "%s · Kundexa" },
  description: "Multi-tenant CRM, dialer, kommunikation och avtal för moderna försäljningsteam.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="sv"><body>{children}</body></html>;
}
