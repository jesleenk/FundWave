"use client";

import { useState } from "react";
import { createCampaign, defaultToken } from "@/lib/contract";
import { useWallet } from "@/lib/wallet";

const MIN_DEADLINE_DAYS = 1;
const MAX_DEADLINE_DAYS = 365;

function defaultDeadline(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

export function CreateForm({ onCreated }: { onCreated: () => void }) {
  const wallet = useWallet();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [goal, setGoal] = useState("1000");
  const [token, setToken] = useState(defaultToken());
  const [deadline, setDeadline] = useState(defaultDeadline());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!wallet.publicKey) {
      setErr("Connect your wallet first");
      return;
    }
    if (!title.trim()) return setErr("Title required");
    if (!goal || Number(goal) <= 0) return setErr("Goal must be > 0");

    const dl = new Date(`${deadline}T23:59:59Z`);
    const now = Date.now();
    const min = now + MIN_DEADLINE_DAYS * 86_400_000;
    const max = now + MAX_DEADLINE_DAYS * 86_400_000;
    if (dl.getTime() < min) return setErr("Deadline is too soon");
    if (dl.getTime() > max) return setErr("Deadline is too far in the future");

    const goalStroops = BigInt(Math.floor(Number(goal) * 10_000_000)).toString();
    setBusy(true);
    setErr(null);
    try {
      await createCampaign(
        {
          creator: wallet.publicKey,
          beneficiary: wallet.publicKey,
          token,
          goal: goalStroops,
          deadlineUnix: Math.floor(dl.getTime() / 1000),
          title: title.trim(),
          description: description.trim(),
        },
        {
          publicKey: wallet.publicKey,
          signTransaction: wallet.signTransaction,
        },
      );
      setTitle("");
      setDescription("");
      setGoal("1000");
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create campaign");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card create-form">
      <h3>Start a campaign</h3>
      <div className="grid">
        <label className="field">
          <span>Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Buy books for the classroom"
            maxLength={64}
            disabled={busy}
          />
        </label>
        <label className="field">
          <span>Goal (XLM)</span>
          <input
            type="number"
            min="0"
            step="0.0000001"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="field">
          <span>Deadline</span>
          <input
            type="date"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="field">
          <span>Token address (SAC)</span>
          <input
            type="text"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={busy}
            className="mono"
          />
        </label>
        <label className="field full">
          <span>Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Why does this matter?"
            maxLength={512}
            rows={3}
            disabled={busy}
          />
        </label>
      </div>
      {err ? <p className="error">{err}</p> : null}
      <div className="row end">
        <button className="btn primary" onClick={submit} disabled={busy}>
          {busy ? "Creating…" : "Create campaign"}
        </button>
      </div>
    </section>
  );
}
