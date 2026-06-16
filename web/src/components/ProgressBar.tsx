"use client";

import { fmtStroops, pct, type Campaign } from "@/lib/contract";
import { useEffect, useState } from "react";

function shortAddr(a: string): string {
  if (!a) return "";
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function timeLeft(deadline: number): string {
  const ms = deadline * 1000 - Date.now();
  if (ms <= 0) return "ended";
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

export function ProgressBar({ value, height = 10 }: { value: number; height?: number }) {
  // smooth animation
  const [w, setW] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setW(value));
    return () => cancelAnimationFrame(id);
  }, [value]);
  return (
    <div
      className="progress"
      style={{ ["--h" as string]: `${height}px`, ["--w" as string]: `${w}%` }}
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
    />
  );
}

export function CampaignCard({
  campaign,
  onDonate,
}: {
  campaign: Campaign;
  onDonate: (c: Campaign) => void;
}) {
  const p = pct(campaign.raised, campaign.goal);
  const isEnded =
    campaign.status === "Failed" ||
    campaign.status === "Withdrawn" ||
    Date.now() / 1000 > campaign.deadline;

  return (
    <article className="card">
      <header className="card-head">
        <h3>{campaign.title || `Campaign #${campaign.id}`}</h3>
        <span className={`pill pill-${campaign.status.toLowerCase()}`}>
          {campaign.status}
        </span>
      </header>
      {campaign.description ? (
        <p className="muted clamp-2">{campaign.description}</p>
      ) : null}
      <div className="numbers">
        <strong>{fmtStroops(campaign.raised)} XLM</strong>
        <span className="muted"> / {fmtStroops(campaign.goal)} XLM</span>
      </div>
      <ProgressBar value={p} />
      <div className="row between">
        <span className="muted small">{p.toFixed(1)}% funded</span>
        <span className="muted small">
          {isEnded ? timeLeft(campaign.deadline) : timeLeft(campaign.deadline)}
        </span>
      </div>
      <div className="row between meta">
        <span className="muted small">by {shortAddr(campaign.creator)}</span>
        <button
          className="btn primary"
          disabled={isEnded || campaign.status !== "Active"}
          onClick={() => onDonate(campaign)}
        >
          Donate
        </button>
      </div>
    </article>
  );
}
