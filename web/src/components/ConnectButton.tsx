"use client";

import { useWallet } from "@/lib/wallet";

export function ConnectButton() {
  const wallet = useWallet();
  if (wallet.publicKey) {
    return (
      <div className="row gap">
        <span className="addr mono">
          {wallet.publicKey.slice(0, 4)}…{wallet.publicKey.slice(-4)}
        </span>
        <button className="btn ghost" onClick={wallet.disconnect}>
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <button
      className="btn primary"
      onClick={wallet.connect}
      disabled={wallet.connecting}
    >
      {wallet.connecting ? "Connecting…" : "Connect wallet"}
    </button>
  );
}
