"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CampaignCard } from "@/components/ProgressBar";
import { CreateForm } from "@/components/CreateForm";
import { DonateModal } from "@/components/DonateModal";
import { ConnectButton } from "@/components/ConnectButton";
import { listCampaigns, type Campaign } from "@/lib/contract";
import { CONTRACT_ID, NETWORK } from "@/lib/network";

const REFRESH_MS = 5_000;

export default function Home() {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [donating, setDonating] = useState<Campaign | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const tickRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const list = await listCampaigns(0, 50);
      // newest first
      list.sort((a, b) => b.id - a.id);
      setCampaigns(list);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load campaigns");
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      tickRef.current += 1;
      refresh();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const totalRaised = useMemo(() => {
    if (!campaigns) return 0n;
    return campaigns.reduce((acc, c) => acc + BigInt(c.raised), 0n);
  }, [campaigns]);

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="logo" />
          <span>FundWave</span>
          <span className="dot" aria-hidden />
        </div>
        <div className="row gap">
          <span className="live">
            <span className="live-dot" /> live · {NETWORK}
          </span>
          <ConnectButton />
        </div>
      </header>

      <main className="container">
        <section className="hero">
          <h1>Fund what matters, on Stellar.</h1>
          <p>
            Launch a campaign in seconds. Donors watch progress update in real
            time. Funds are held by the contract and only released to the
            creator when the goal is met.
          </p>
        </section>

        {!CONTRACT_ID ? (
          <div className="empty">
            <strong>Contract not deployed.</strong>
            <p className="small">
              Run <code>./scripts/deploy.sh</code> from the repo root, then
              restart <code>pnpm dev</code>.
            </p>
          </div>
        ) : null}

        {err ? <p className="error">{err}</p> : null}

        <section className="row between" style={{ margin: "8px 0 16px" }}>
          <div>
            <span className="muted small">
              {campaigns?.length ?? 0} campaign
              {(campaigns?.length ?? 0) === 1 ? "" : "s"} ·
              {" "}
              {(Number(totalRaised) / 10_000_000).toFixed(2)} XLM raised
            </span>
          </div>
          <button
            className="btn primary"
            onClick={() => setShowCreate((v) => !v)}
          >
            {showCreate ? "Close" : "New campaign"}
          </button>
        </section>

        {showCreate ? (
          <CreateForm
            onCreated={() => {
              setShowCreate(false);
              refresh();
            }}
          />
        ) : null}

        {campaigns === null ? (
          <div className="empty">Loading campaigns…</div>
        ) : campaigns.length === 0 ? (
          <div className="empty">
            No campaigns yet. Be the first to start one.
          </div>
        ) : (
          <div className="grid">
            {campaigns.map((c) => (
              <CampaignCard
                key={c.id}
                campaign={c}
                onDonate={(camp) => setDonating(camp)}
              />
            ))}
          </div>
        )}

        <footer className="foot">
          Built on Stellar · contract <code className="mono">{CONTRACT_ID || "—"}</code>
        </footer>
      </main>

      {donating ? (
        <DonateModal campaign={donating} onClose={() => setDonating(null)} />
      ) : null}
    </>
  );
}
