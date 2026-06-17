"use client";

import { useState } from "react";
import { donate, fmtStroops, type Campaign } from "@/lib/contract";
import { useWallet } from "@/lib/wallet";

export function DonateModal({
  campaign,
  onClose,
}: {
  campaign: Campaign;
  onClose: () => void;
}) {
  const wallet = useWallet();
  const [amount, setAmount] = useState("10");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!wallet.publicKey) {
      setErr("Connect your wallet first");
      return;
    }
    const stroops = BigInt(Math.floor(Number(amount) * 10_000_000)).toString();
    if (stroops === "0") {
      setErr("Enter an amount greater than 0");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await donate(
        { id: campaign.id, donor: wallet.publicKey, amount: stroops },
        {
          publicKey: wallet.publicKey,
          signTransaction: wallet.signTransaction,
        },
      );
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Donation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{`Donate to &ldquo;${campaign.title}&rdquo;`}</h3>
        <p className="muted small">
          {fmtStroops(campaign.raised)} / {fmtStroops(campaign.goal)} XLM raised
        </p>
        <label className="field">
          <span>Amount (XLM)</span>
          <input
            type="number"
            min="0"
            step="0.0000001"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
          />
        </label>
        {err ? <p className="error">{err}</p> : null}
        <div className="row end gap">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? "Submitting…" : "Donate"}
          </button>
        </div>
      </div>
    </div>
  );
}
