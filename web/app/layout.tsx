import type { Metadata } from "next";

export const metadata: Metadata = { title: "Cannon — SRE Triage Agent" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#030712", color: "#e2e8f0", minHeight: "100vh" }}>
        <header style={{ borderBottom: "1px solid #1f2937", padding: "12px 24px", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: "#a78bfa", fontFamily: "monospace", fontWeight: 700, fontSize: 18 }}>⬡ CANNON</span>
          <span style={{ color: "#4b5563", fontFamily: "monospace", fontSize: 12 }}>autonomous SRE triage</span>
        </header>
        {children}
      </body>
    </html>
  );
}
