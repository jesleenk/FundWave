import type { Metadata } from "next";
import { WalletProvider } from "@/lib/wallet";
import "./globals.css";

export const metadata: Metadata = {
  title: "FundWave — crowdfunding on Stellar",
  description: "Collect donations with real-time progress, powered by Soroban.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
