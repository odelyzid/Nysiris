/**
 * Desktop three-zone shell (AIM / Jabber-roster style): top bar, roster
 * sidebar, main conversation area (rendered by `App`), collapsible context
 * panel. All three components are presentational — state lives in `App`.
 *
 * Narrow screens are unaffected: `.fly-topbar`, `.fly-roster`, and
 * `.fly-context` are `display:none` below 1024px (see `theme.css`), where
 * the classic header + `AppNav` take over again.
 */
import { useState, type ReactNode } from 'react';
import type { TunnelStateView } from '../../../mixnet/tunnel';
import { VIEW_META, VIEW_ORDER, type ViewId } from '../../../application/views';
import { StatusPill } from '../shared/StatusPill';
import { copyText, displayLabel, petnameFor, shortenAddress } from '../../../shared/share';
import { STANDING_META } from '../../../domain/trust';
import type { Contact } from '../../../application/contacts';

/* ------------------------------------------------------------------ top bar */

export function TopBar({
  view,
  onSelectView,
  status,
  statusDetail,
  onRetry,
  busy,
  uri,
  onUriChange,
  onGo,
  advanced,
  onToggleAdvanced,
  contextOpen,
  onToggleContext,
}: {
  view: ViewId;
  onSelectView: (view: ViewId) => void;
  status: TunnelStateView;
  statusDetail?: string;
  onRetry: () => void;
  busy: boolean;
  uri: string;
  onUriChange: (uri: string) => void;
  onGo: () => void;
  advanced: boolean;
  onToggleAdvanced: (next: boolean) => void;
  contextOpen: boolean;
  onToggleContext: () => void;
}) {
  return (
    <div className="fly-topbar" role="banner">
      <span className="fly-wordmark">nysiris</span>
      <nav aria-label="Primary" className="fly-topbar-nav">
        {VIEW_ORDER.map((id) => (
          <button
            key={id}
            className="fly-nav-btn"
            aria-current={view === id ? 'page' : undefined}
            title={VIEW_META[id].blurb}
            onClick={() => onSelectView(id)}
          >
            {VIEW_META[id].title}
          </button>
        ))}
      </nav>
      <StatusPill status={status} detail={statusDetail} onRetry={onRetry} busy={busy} />
      {busy && <span className="fly-ie-spinner" role="status" aria-label="Loading" title="Loading…" />}
      <span className="fly-topbar-spacer" />
      <input
        className="fly-input uri-input"
        placeholder="Private link or address"
        value={uri}
        onChange={(e) => onUriChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onGo();
        }}
        spellCheck={false}
        aria-label="Private link"
      />
      <button className="fly-btn fly-btn-primary" onClick={onGo} disabled={busy || !uri}>
        Open
      </button>
      <button
        className="fly-btn"
        aria-pressed={advanced}
        title="Technical tools (also in Settings)"
        onClick={() => onToggleAdvanced(!advanced)}
      >
        Advanced
      </button>
      <button
        className="fly-btn"
        aria-pressed={contextOpen}
        title={contextOpen ? 'Hide the info panel' : 'Show the info panel'}
        onClick={onToggleContext}
      >
        Info
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ roster */

export interface RosterPortal {
  address: string;
  /** The portal the main area is currently bound to. */
  current: boolean;
  /** Selected (portal view open on this address). */
  active: boolean;
}

export interface RosterThread {
  key: string;
  label: string;
  active: boolean;
  unread: number;
}

function Dot({ color, title }: { color: string; title: string }) {
  return <span className="fly-dot" title={title} style={{ backgroundColor: color }} aria-hidden="true" />;
}

export function Roster({
  portals,
  contacts,
  threads,
  selfAddress,
  onOpenPortal,
  onOpenContact,
  onSelectThread,
}: {
  portals: RosterPortal[];
  contacts: Contact[];
  threads: RosterThread[];
  selfAddress: string;
  onOpenPortal: (address: string) => void;
  onOpenContact: (address: string) => void;
  onSelectThread: (key: string) => void;
}) {
  return (
    <aside className="fly-roster" aria-label="Roster">
      <section aria-label="Portals">
        <h3>Portals</h3>
        {portals.length === 0 && <p className="fly-muted">No portals yet — open a private link above.</p>}
        <ul>
          {portals.map((p) => (
            <li key={p.address}>
              <button aria-current={p.active} onClick={() => onOpenPortal(p.address)} title={p.address}>
                <Dot
                  color={p.current ? STANDING_META.trusted.color : STANDING_META.unknown.color}
                  title={p.current ? 'Open now' : 'Recently visited'}
                />
                <span>
                  {shortenAddress(p.address)}
                  {p.current && <span className="fly-sub">open now</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Contacts">
        <h3>Contacts</h3>
        {contacts.length === 0 && <p className="fly-muted">Nobody saved yet — save an invite to grow this list.</p>}
        <ul>
          {contacts.map((c) => (
            <li key={c.name}>
              <button onClick={() => onOpenContact(c.address)} title={c.address}>
                <Dot color={STANDING_META.unknown.color} title="Saved contact" />
                <span>
                  {displayLabel(c.address, petnameFor(c.address, contacts))}
                  <span className="fly-sub">{shortenAddress(c.address)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Recent conversations">
        <h3>Recent</h3>
        {threads.length === 0 && <p className="fly-muted">No conversations yet.</p>}
        <ul>
          {threads.map((t) => (
            <li key={t.key}>
              <button aria-current={t.active} onClick={() => onSelectThread(t.key)}>
                <Dot
                  color={t.active ? STANDING_META.trusted.color : STANDING_META.unknown.color}
                  title={t.active ? 'Open now' : 'Conversation'}
                />
                <span>{t.label}</span>
                {t.unread > 0 && (
                  <span className="fly-badge" aria-label={`${t.unread} unread`}>
                    {t.unread}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <p className="fly-muted fly-roster-self">
        {selfAddress ? `you: ${shortenAddress(selfAddress)}` : 'Messaging is off.'}
      </p>
    </aside>
  );
}

/* ------------------------------------------------------------ context panel */

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="fly-btn"
      style={{ fontSize: 12, minHeight: 32, padding: '6px 12px', marginTop: 4 }}
      onClick={() => {
        void copyText(text).then((ok) => setCopied(ok));
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function ContextPanel({
  view,
  open,
  onToggle,
  portalService,
  portalBound,
  inviteFrom,
  threadLabel,
  threadAddress,
  statusLabel,
  statusTone,
  clearnetIp,
  mixnetIp,
  advanced,
  onToggleAdvanced,
}: {
  view: ViewId;
  open: boolean;
  onToggle: () => void;
  portalService: string;
  portalBound: boolean;
  inviteFrom: string | null;
  threadLabel: string | null;
  threadAddress: string | null;
  statusLabel: string;
  statusTone: string;
  clearnetIp: string;
  mixnetIp: string;
  advanced: boolean;
  onToggleAdvanced: (next: boolean) => void;
}) {
  if (!open) return null;
  return (
    <aside className="fly-context" aria-label="Details">
      <div className="fly-context-head">
        <h3>
          {view === 'portal'
            ? 'Portal'
            : view === 'service'
              ? 'Service'
              : view === 'messages'
                ? 'Conversation'
                : view === 'home'
                  ? 'Connection'
                  : 'Settings'}
        </h3>
        <button className="fly-btn" onClick={onToggle} aria-label="Hide the info panel">
          »
        </button>
      </div>
      <dl className="fly-info">
        {view === 'portal' && (
          <>
            <InfoRow label="Service">
              {portalService ? (
                <>
                  {shortenAddress(portalService)}
                  <br />
                  <CopyButton text={portalService} />
                </>
              ) : (
                'No portal open — paste a private link above.'
              )}
            </InfoRow>
            <InfoRow label="Community">
              {portalBound ? 'Bound — timeline and DMs use this service.' : 'Not bound yet.'}
            </InfoRow>
            {inviteFrom && <InfoRow label="Invited by">{shortenAddress(inviteFrom)}</InfoRow>}
          </>
        )}
        {view === 'messages' && (
          <>
            <InfoRow label="With">{threadLabel ?? 'No conversation selected.'}</InfoRow>
            {threadAddress && (
              <InfoRow label="Address">
                {shortenAddress(threadAddress)}
                <br />
                <CopyButton text={threadAddress} />
              </InfoRow>
            )}
          </>
        )}
        {view === 'service' && (
          <>
            <InfoRow label="Portal service">
              The browser is only the client — the service runs as a separate program.
            </InfoRow>
            <InfoRow label="Identity">A keypair separate from your social identity.</InfoRow>
          </>
        )}
        {view === 'home' && (
          <>
            <InfoRow label="Status">
              <Dot color={statusTone} title={statusLabel} /> {statusLabel}
            </InfoRow>
            {(clearnetIp || mixnetIp) && (
              <InfoRow label="Addresses">
                everyday {clearnetIp || '—'}
                <br />
                private {mixnetIp || '—'}
              </InfoRow>
            )}
          </>
        )}
        {view === 'settings' && (
          <>
            <InfoRow label="Technical tools">
              <button className="fly-btn" aria-expanded={advanced} onClick={() => onToggleAdvanced(!advanced)}>
                {advanced ? 'Hide advanced' : 'Show advanced'}
              </button>
            </InfoRow>
            <InfoRow label="Storage">Everything stays on this device.</InfoRow>
          </>
        )}
      </dl>
    </aside>
  );
}
