/**
 * Portal replica panel (reads only). Pulls heads → logs → objects over the
 * mixnet from any portal provider address and shows what the local replica
 * holds. Rendering + effects only — all protocol logic and transport live in
 * `social/portalSync.ts` / `portalSyncIo.ts`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  defaultPortalSyncStorage,
  describePortalSync,
  loadPortalReplica,
  portalHeads,
  savePortalReplica,
  type PortalReplica,
  type PortalSyncStatus,
} from '../social/portalSync';
import { syncPortalReplica, type PortalSyncSummary } from '../social/portalSyncIo';
import { defaultPortalRunStorage, loadPortalRun } from '../social/runPortal';

function shortHex(hex: string): string {
  return hex.length > 12 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex;
}

export function PortalSync() {
  const [address, setAddress] = useState(() => loadPortalRun(defaultPortalRunStorage()).providerAddress);
  const [replica, setReplica] = useState<PortalReplica>(() => loadPortalReplica(defaultPortalSyncStorage()));
  const [status, setStatus] = useState<PortalSyncStatus>({ syncing: false, lastSyncedAt: null, error: null });
  const [summary, setSummary] = useState<PortalSyncSummary | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    savePortalReplica(replica, defaultPortalSyncStorage());
  }, [replica]);

  const heads = useMemo(() => portalHeads(replica), [replica]);

  const onSync = async () => {
    const target = address.trim();
    if (!target) {
      setStatus((s) => ({ ...s, error: 'Enter a portal provider address first.' }));
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setStatus({ syncing: true, lastSyncedAt: null, error: null });
    try {
      const { replica: next, summary: nextSummary } = await syncPortalReplica(target, replica, { timeoutMs: 120_000 });
      setReplica(next);
      setSummary(nextSummary);
      setStatus({ syncing: false, lastSyncedAt: Date.now(), error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ syncing: false, lastSyncedAt: status.lastSyncedAt, error: message });
    } finally {
      busyRef.current = false;
    }
  };

  const line = describePortalSync(Date.now(), status);
  const authors = Object.entries(heads).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const failed = summary?.failed ?? [];

  return (
    <div>
      <p className="fly-muted" style={{ maxWidth: 560 }}>
        Pull a partial replica from a portal provider: heads, logs, and verified objects. Reads only — nothing is
        pushed. Splitting authors (forks) are flagged and never merged.
      </p>
      <div className="fly-row" style={{ marginTop: 8 }}>
        <input
          className="fly-input"
          placeholder="portal provider address (id.enc@gw)"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          spellCheck={false}
        />
        <button className="fly-btn" onClick={() => void onSync()} disabled={status.syncing}>
          {status.syncing ? 'Syncing…' : 'Sync'}
        </button>
      </div>
      <p style={{ fontSize: 13, marginTop: 4 }}>{line.text}</p>
      {summary && (
        <p style={{ fontSize: 13, marginTop: 4 }}>
          {summary.authors} author{summary.authors === 1 ? '' : 's'} advanced · {summary.entries} entries ·{' '}
          {summary.objects} objects verified
          {failed.length > 0 && ` · ${failed.length} flagged (${failed.map(shortHex).join(', ')})`}
        </p>
      )}
      <h3 style={{ fontSize: 15, marginTop: 10 }}>Local replica</h3>
      {authors.length === 0 ? (
        <p style={{ fontSize: 13 }} className="fly-muted">
          Nothing synced yet.
        </p>
      ) : (
        <ul style={{ fontSize: 13 }}>
          {authors.map(([author, seq]) => (
            <li key={author}>
              {shortHex(author)} — {seq} entry{seq === 1 ? '' : 's'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}