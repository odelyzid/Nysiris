import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ensureTunnel, teardownTunnel, tunnelState, type TunnelStateView } from './mixnet/tunnel';
import { exitStatus, proveTunnel } from './mixnet/fetch';
import { NymAddressClient, type IncomingMessage } from './mixnet/messaging';
import { fetchNym } from './mixnet/fetchNym';
import { parseInviteLink } from './mixnet/hiddenService.mjs';
import { Social } from './social/Social';
import { verifyInvite } from './social/identity';
import {
  loadTrust,
  saveTrust,
  withVerdict,
  type Verdict,
} from './social/trust';
import { Panel } from './ui/Panel';
import { Toolbar } from './ui/Toolbar';
import { ContactsPanel, type PendingInvite } from './ui/ContactsPanel';
import { PortalSync } from './ui/PortalSync';
import {
  defaultContactStorage,
  loadContacts,
  saveContacts,
  type Contact,
} from './ui/contacts';
import { defaultStorage, loadOpenPanels, saveOpenPanels, type PanelId } from './ui/panels';
import { describeStatus } from './mixnet/status';
import { AppNav } from './ui/AppNav';
import { Onboarding } from './ui/Onboarding';
import { FriendlyError } from './ui/FriendlyError';
import { QrScanButton } from './ui/QrScanButton';
import { ShareCard } from './ui/ShareCard';
import { RunPortal } from './ui/RunPortal';
import {
  defaultViewStorage,
  loadActiveView,
  loadAdvancedVisible,
  loadOnboarded,
  saveActiveView,
  saveAdvancedVisible,
  saveOnboarded,
  type ViewId,
} from './ui/views';
import { friendlyError } from './ui/friendlyErrors';
import { shortenAddress, threadKeyFor, threadLabel } from './ui/share';
import { ContextPanel, Roster, TopBar } from './ui/DesktopShell';
import {
  loadActiveThread,
  loadContextOpen,
  loadRecentPortals,
  rememberPortal,
  saveActiveThread,
  saveContextOpen,
  saveRecentPortals,
} from './ui/shell';

const NYM_API_URL = 'https://validator.nymtech.net/api';

export function App() {
  const [status, setStatus] = useState<TunnelStateView>({ state: 'shutdown' });
  const [log, setLog] = useState<string[]>([]);
  const [clearnetIp, setClearnetIp] = useState<string>('');
  const [mixnetIp, setMixnetIp] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [exit, setExit] = useState(() => exitStatus());
  const [lastError, setLastError] = useState<unknown>(null);

  // Primary navigation (persisted). Technical panels keep their own
  // persistence underneath, inside Settings → Advanced.
  const [view, setView] = useState<ViewId>(() => loadActiveView(defaultViewStorage()));
  const [advanced, setAdvanced] = useState(() => loadAdvancedVisible(defaultViewStorage()));
  const [onboarded, setOnboarded] = useState(() => loadOnboarded(defaultViewStorage()));

  // Direct Nym-address messaging state.
  const clientRef = useRef<NymAddressClient | null>(null);
  const [selfAddress, setSelfAddress] = useState('');
  const [recipient, setRecipient] = useState('');
  const [draft, setDraft] = useState('');
  const [inbox, setInbox] = useState<IncomingMessage[]>([]);
  // Restored on load so the roster reopens where you left off.
  const [activeThread, setActiveThread] = useState<string | null>(() => loadActiveThread(defaultViewStorage()));
  // Per-thread read watermarks (session-only): inbox size seen while open.
  const [readCounts, setReadCounts] = useState<Record<string, number>>({});

  // Hidden-service fetch state (fetchNym: one call, one response).
  const [hsAddress, setHsAddress] = useState('');
  const [hsPath, setHsPath] = useState('/');
  const [hsResult, setHsResult] = useState('');

  // The service the URI bar last navigated to. The Social section binds to
  // this: navigating *is* connecting the social client to that service.
  const [socialService, setSocialService] = useState('');
  // Recently opened portals for the desktop roster, newest first.
  const [recentPortals, setRecentPortals] = useState<string[]>(() => loadRecentPortals(defaultViewStorage()));
  // Desktop context panel visibility (persisted; narrow screens ignore it).
  const [contextOpen, setContextOpen] = useState(() => loadContextOpen(defaultViewStorage()));

  // Contacts: local-only address book + pending invite from the URI bar.
  const [contacts, setContacts] = useState<Contact[]>(() => loadContacts(defaultContactStorage()));
  const [pendingInvite, setPendingInvite] = useState<PendingInvite | null>(null);

  // Local web-of-trust: explicit Trust/Block verdicts per author. Owned here
  // (not in Social) so both the timeline and the invite banner can read and
  // write them. Everything stays on this device.
  const [trustMap, setTrustMap] = useState<Record<string, Verdict>>(() => {
    try {
      return loadTrust(localStorage);
    } catch {
      return {};
    }
  });

  const onVerdict = useCallback((author: string, verdict: Verdict | null) => {
    setTrustMap((prev) => {
      const next = withVerdict(prev, author, verdict);
      try {
        saveTrust(next, localStorage);
      } catch {
        // Private mode: verdicts just don't persist.
      }
      return next;
    });
  }, []);

  const [petname, setPetname] = useState('');

  // Top URI bar: paste a private link and go. Behaviour unchanged —
  // `parseInviteLink` → `fetchNym` → bind the Portal to the service.
  const [uri, setUri] = useState('');
  const [pageHtml, setPageHtml] = useState<string | null>(null);

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-99), `${new Date().toLocaleTimeString()}  ${line}`]);
  }, []);

  // One-tap trust for IDs an inviter vouched for. The invite signature
  // already proved the inviter said it — this records your own call.
  // Declared after `append` since it logs the result.
  const onTrustVouched = useCallback((authors: string[]) => {
    setTrustMap((prev) => {
      let next = prev;
      for (const author of authors) next = withVerdict(next, author, 'trusted');
      try {
        saveTrust(next, localStorage);
      } catch {
        // Private mode: verdicts just don't persist.
      }
      return next;
    });
    append(`trusted ${authors.length} vouched ${authors.length === 1 ? 'ID' : 'IDs'}`);
  }, [append]);

  // Keep the UI status honest.
  useEffect(() => {
    const id = window.setInterval(() => {
      void tunnelState().then(setStatus);
      setExit(exitStatus());
    }, 2000);
    return () => window.clearInterval(id);
  }, []);

  const onSelectView = useCallback((next: ViewId) => {
    setView(next);
    saveActiveView(next, defaultViewStorage());
  }, []);

  const onToggleAdvanced = useCallback((next: boolean) => {
    setAdvanced(next);
    saveAdvancedVisible(next, defaultViewStorage());
  }, []);

  const onDismissOnboarding = useCallback(() => {
    setOnboarded(true);
    saveOnboarded(true, defaultViewStorage());
  }, []);

  // Roster continuity: remember the open thread and panel across loads.
  useEffect(() => {
    saveActiveThread(activeThread, defaultViewStorage());
  }, [activeThread]);

  const onToggleContext = useCallback(() => {
    setContextOpen((prev) => {
      saveContextOpen(!prev, defaultViewStorage());
      return !prev;
    });
  }, []);

  const onSelectThread = useCallback(
    (key: string) => {
      setActiveThread(key);
      if (key.startsWith('contact:')) {
        setRecipient(key.slice('contact:'.length));
      }
      onSelectView('messages');
    },
    [onSelectView],
  );

  const onConnect = useCallback(async () => {
    setBusy(true);
    setLastError(null);
    try {
      append('bringing up mixnet tunnel…');
      await ensureTunnel({ debug: import.meta.env.DEV });
      setStatus(await tunnelState());
      append('tunnel requested');
    } catch (err) {
      setLastError(err);
      append(`tunnel error: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [append]);

  const onDisconnect = useCallback(async () => {
    setBusy(true);
    try {
      await teardownTunnel();
      append('tunnel torn down (reload the page to reconnect)');
      setStatus(await tunnelState());
    } catch (err) {
      setLastError(err);
    } finally {
      setBusy(false);
    }
  }, [append]);

  const onProveTunnel = useCallback(async () => {
    setBusy(true);
    setLastError(null);
    try {
      const { clearnet, mixnet, differ } = await proveTunnel('https://api.ipify.org?format=json');
      setClearnetIp(clearnet);
      setMixnetIp(mixnet);
      append(`clearnet=${clearnet} mixnet=${mixnet} differ=${differ}`);
    } catch (err) {
      setLastError(err);
      append(`proof failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [append]);

  const onStartMessaging = useCallback(async () => {
    setBusy(true);
    setLastError(null);
    try {
      const client = clientRef.current ?? new NymAddressClient();
      clientRef.current = client;
      const address = await client.start(
        NYM_API_URL,
        (msg) => setInbox((prev) => [...prev, msg]),
        (reason) => append(`inbound reply rejected: ${reason}`),
      );
      setSelfAddress(address);
      append(`Nym-address client ready: ${address}`);
    } catch (err) {
      setLastError(err);
      append(`messaging start failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [append]);

  const onSend = useCallback(async () => {
    if (!clientRef.current || !recipient || !draft) return;
    setLastError(null);
    try {
      await clientRef.current.send(recipient, draft);
      append(`sent to ${recipient}`);
      setDraft('');
    } catch (err) {
      setLastError(err);
      append(`send failed: ${String(err)}`);
    }
  }, [recipient, draft, append]);

  const onReply = useCallback(
    async (msg: IncomingMessage) => {
      if (!clientRef.current || !msg.senderTag) return;
      try {
        await clientRef.current.reply(msg.senderTag, `re: ${msg.text}`);
        append('anonymous SURB reply sent');
      } catch (err) {
        setLastError(err);
        append(`reply failed: ${String(err)}`);
      }
    },
    [append],
  );

  const onFetchNym = useCallback(async () => {
    if (!hsAddress || !hsPath) return;
    setBusy(true);
    setLastError(null);
    try {
      append(`fetchNym ${hsPath} @ ${hsAddress.slice(0, 12)}…`);
      const res = await fetchNym(
        hsAddress,
        { method: 'GET', path: hsPath },
        { timeoutMs: 120_000 },
      );
      const text = new TextDecoder().decode(res.body);
      setHsResult(`status=${res.status} error=${res.error ?? 'none'}\n${text.slice(0, 2000)}`);
      append(`fetchNym done: status=${res.status} body=${res.body.length}B`);
    } catch (err) {
      setLastError(err);
      append(`fetchNym failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [hsAddress, hsPath, append]);

  const goTo = useCallback(async (raw: string) => {
    if (!raw) return;
    setBusy(true);
    setLastError(null);
    setPageHtml(null);
    try {
      // Invite links carry a #invite= fragment: parse it, but never send it.
      const { address, path, invite } = parseInviteLink(raw);
      if (invite) {
        setPendingInvite({
          address,
          path,
          inviter: invite.inviter,
          note: invite.note,
          invite,
        });
        setPetname('');
        append(`invite from ${invite.inviter.slice(0, 12)}…: “${invite.note}”`);
      }
      append(`nym:// fetch ${path} @ ${address.slice(0, 12)}…`);
      const res = await fetchNym(
        address,
        { method: 'GET', path, headers: { accept: 'text/html' } },
        { timeoutMs: 120_000 },
      );
      if (res.error) {
        setHsResult(`status=${res.status} error=${res.error}`);
        append(`nym:// done with service error: ${res.error}`);
        return;
      }
      // Successful navigation binds the social client to this service, so its
      // timeline, composer, and DMs operate on what you just fetched.
      setSocialService(address);
      setRecentPortals((prev) => {
        const next = rememberPortal(prev, address);
        saveRecentPortals(next, defaultViewStorage());
        return next;
      });
      const text = new TextDecoder().decode(res.body);
      const contentType = res.headers['content-type'] ?? '';
      if (contentType.includes('html')) {
        // Sandboxed: no scripts, no forms, opaque origin. Service HTML is
        // rendered, never executed.
        setPageHtml(text);
        setHsResult(`status=${res.status} body=${res.body.length}B (rendered below)`);
      } else {
        let shown = text.slice(0, 2000);
        if (contentType.includes('json')) {
          try {
            shown = JSON.stringify(JSON.parse(text), null, 2).slice(0, 2000);
          } catch {
            // fall back to raw text
          }
        }
        setHsResult(`status=${res.status}\n${shown}`);
      }
      append(`nym:// done: status=${res.status} body=${res.body.length}B`);
    } catch (err) {
      setLastError(err);
      append(`nym:// failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [append]);

  const onGo = useCallback(() => {
    void goTo(uri);
    onSelectView('portal');
  }, [goTo, uri, onSelectView]);

  // "Run a Portal" tab: probe a running provider's address through the tunnel.
  const onProbePortal = useCallback(
    async (address: string): Promise<{ ok: boolean; summary: string }> => {
      append(`probe ${address.slice(0, 12)}…`);
      try {
        const res = await fetchNym(
          address,
          { method: 'GET', path: '/' },
          { timeoutMs: 120_000 },
        );
        const text = new TextDecoder().decode(res.body);
        return {
          ok: !res.error && res.status >= 200 && res.status < 500,
          summary: `status=${res.status}${res.error ? ` error=${res.error}` : ''} ${text.slice(0, 200)}`.trim(),
        };
      } catch (err) {
        append(`probe failed: ${String(err)}`);
        return { ok: false, summary: String(err) };
      }
    },
    [append],
  );

  const onVisitContact = useCallback(
    (address: string) => {
      setUri(address);
      void goTo(address);
      onSelectView('portal');
    },
    [goTo, onSelectView],
  );

  const onRemoveContact = useCallback(
    (name: string) => {
      setContacts((prev) => {
        const next = prev.filter((c) => c.name !== name);
        saveContacts(next, defaultContactStorage());
        return next;
      });
      append(`contact removed: ${name}`);
    },
    [append],
  );

  const onAcceptInvite = useCallback(() => {
    if (!pendingInvite || !petname.trim()) return;
    // Verify the signature before saving: an invite is only as good as its proof.
    if (!verifyInvite(pendingInvite.invite, pendingInvite.address)) {
      setLastError(new Error('invite signature invalid — not saved'));
      append('invite signature invalid — not saved');
      return;
    }
    setContacts((prev) => {
      const name = petname.trim().toLowerCase();
      if (prev.some((c) => c.name === name)) {
        append(`contact ${name} already saved`);
        return prev;
      }
      const next = [
        ...prev,
        {
          name,
          address: pendingInvite.address,
          inviter: pendingInvite.inviter,
          note: pendingInvite.note,
          addedAt: Date.now(),
        },
      ];
      saveContacts(next, defaultContactStorage());
      return next;
    });
    append(`contact saved: ${petname.trim()}`);
    setPendingInvite(null);
    setPetname('');
  }, [pendingInvite, petname, append]);

  // Toolbar-controlled panels (Advanced). Closed panels only hide their view —
  // background work (tunnel, inbox, polling) keeps running. Persisted.
  const [openPanels, setOpenPanels] = useState<PanelId[]>(() => loadOpenPanels(defaultStorage()));

  const onTogglePanel = useCallback((id: PanelId) => {
    setOpenPanels((prev) => {
      const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
      saveOpenPanels(next, defaultStorage());
      return next;
    });
  }, []);

  const onClosePanel = useCallback(
    (id: PanelId) => {
      setOpenPanels((prev) => {
        const next = prev.filter((p) => p !== id);
        saveOpenPanels(next, defaultStorage());
        return next;
      });
    },
    [],
  );

  const { label, tone } = describeStatus(status);

  // Messages: group the inbox into threads by sender; contacts start new ones.
  const threads = useMemo(() => {
    const keys: string[] = [];
    inbox.forEach((m, i) => {
      const key = threadKeyFor(m, i);
      if (!keys.includes(key)) keys.push(key);
    });
    for (const c of contacts) {
      const key = `contact:${c.address}`;
      if (!keys.includes(key)) keys.push(key);
    }
    return keys;
  }, [inbox, contacts]);

  const activeMessages = useMemo(() => {
    if (!activeThread) return [];
    if (activeThread.startsWith('contact:')) return [];
    return inbox.filter((m, i) => threadKeyFor(m, i) === activeThread);
  }, [inbox, activeThread]);

  // Inbox size per thread for the roster's unread badges.
  const threadCounts = useMemo(() => {
    const counts = new Map<string, number>();
    inbox.forEach((m, i) => {
      const key = threadKeyFor(m, i);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return counts;
  }, [inbox]);

  // Opening a thread (or receiving into the open one) marks it read.
  useEffect(() => {
    if (!activeThread) return;
    const seen = threadCounts.get(activeThread) ?? 0;
    setReadCounts((prev) => (prev[activeThread] === seen ? prev : { ...prev, [activeThread]: seen }));
  }, [activeThread, threadCounts]);

  // Desktop roster rows, derived from the same state as the main views.
  const rosterPortals = useMemo(() => {
    const rows = recentPortals
      .filter((a) => a !== socialService)
      .map((address) => ({ address, current: false, active: false }));
    if (socialService) {
      rows.unshift({ address: socialService, current: true, active: view === 'portal' });
    }
    return rows;
  }, [recentPortals, socialService, view]);

  const rosterThreads = useMemo(
    () =>
      threads.map((key) => {
        const total = threadCounts.get(key) ?? 0;
        return {
          key,
          label: threadLabel(key, contacts),
          active: key === activeThread,
          unread: Math.max(0, total - (readCounts[key] ?? 0)),
        };
      }),
    [threads, threadCounts, contacts, activeThread, readCounts],
  );

  const activeThreadAddress = useMemo(() => {
    if (!activeThread) return null;
    if (activeThread.startsWith('contact:')) return activeThread.slice('contact:'.length);
    return null;
  }, [activeThread]);

  const onboardingStep = !onboarded
    ? status.state === 'ready'
      ? 'done'
      : status.state === 'connecting'
        ? 'connecting'
        : 'welcome'
    : 'done';

  const statusDetail = lastError ? friendlyError(lastError).technical : undefined;

  return (
    <div className="fly-shell">
      <TopBar
        view={view}
        onSelectView={onSelectView}
        status={status}
        statusDetail={statusDetail}
        onRetry={onConnect}
        busy={busy}
        uri={uri}
        onUriChange={setUri}
        onGo={onGo}
        advanced={advanced}
        onToggleAdvanced={onToggleAdvanced}
        contextOpen={contextOpen}
        onToggleContext={onToggleContext}
      />
      <div className="fly-desktop" data-context={contextOpen ? 'open' : 'closed'}>
        <Roster
          portals={rosterPortals}
          contacts={contacts}
          threads={rosterThreads}
          selfAddress={selfAddress}
          onOpenPortal={onVisitContact}
          onOpenContact={onVisitContact}
          onSelectThread={onSelectThread}
        />
        <div className="fly-main">
          <header className="fly-classic-header">
            <h1 style={{ margin: '8px 0 0', fontSize: 22 }}>Nysiris</h1>
            <p className="fly-muted" style={{ margin: '4px 0 8px' }}>
              Browse and chat over the private network.
            </p>
          </header>

          <AppNav
            active={view}
            onSelect={onSelectView}
            status={status}
            statusDetail={statusDetail}
            onRetry={onConnect}
            busy={busy}
          />

      {lastError !== null && lastError !== undefined && view !== 'settings' && (
        <FriendlyError error={lastError} onRetry={onConnect} retrying={busy} />
      )}

      {view === 'home' && (
        <main>
          {!onboarded && onboardingStep !== 'done' && (
            <Onboarding
              step={onboardingStep}
              busy={busy}
              error={lastError}
              onConnect={() => void onConnect()}
              onDismiss={onDismissOnboarding}
            />
          )}
          {!onboarded && onboardingStep === 'done' && (
            <section className="fly-card" aria-label="You're protected">
              <h2>You are protected ✓</h2>
              <p>Your traffic is travelling the private network. Open a private link or say hello.</p>
              <div className="fly-row">
                <button
                  className="fly-btn fly-btn-primary"
                  onClick={() => {
                    onDismissOnboarding();
                    onSelectView('portal');
                  }}
                >
                  Get started
                </button>
              </div>
            </section>
          )}

          <section className="fly-card" aria-label="Protection status">
            <h2>{status.state === 'ready' ? 'You are protected' : status.state === 'connecting' ? 'Connecting…' : 'Not protected yet'}</h2>
            <p>
              {status.state === 'ready'
                ? 'Your connection is running over the private network.'
                : status.state === 'connecting'
                  ? 'Finding the fastest private path. This usually takes a few seconds.'
                  : 'Connect once — we handle the private path for you.'}
            </p>
            <div className="fly-row">
              {status.state !== 'ready' && (
                <button className="fly-btn fly-btn-primary" onClick={() => void onConnect()} disabled={busy}>
                  Connect privately
                </button>
              )}
              {status.state === 'ready' && (
                <>
                  <button className="fly-btn" onClick={() => void onProveTunnel()} disabled={busy}>
                    Prove I am protected
                  </button>
                  <button className="fly-btn" onClick={() => void onDisconnect()} disabled={busy}>
                    Switch off
                  </button>
                </>
              )}
            </div>
            {(clearnetIp || mixnetIp) && (
              <p className="fly-muted">
                {clearnetIp && mixnetIp
                  ? clearnetIp !== mixnetIp
                    ? 'Checked: your private address differs from your everyday one. ✓'
                    : 'Checked: the addresses look the same — try again in a moment.'
                  : 'Check in progress…'}
              </p>
            )}
          </section>

          <section
            className="fly-card"
            aria-label="Open a private link"
            style={socialService ? { display: 'none' } : undefined}
          >
            <h2>Open a private link</h2>
            <p>Paste a link someone shared with you. It opens privately on this device.</p>
            <div className="fly-row">
              <input
                className="fly-input"
                placeholder="Paste a private link, then press Enter"
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onGo();
                }}
                spellCheck={false}
                aria-label="Private link"
              />
              <button className="fly-btn fly-btn-primary" onClick={onGo} disabled={busy || !uri}>
                Open
              </button>
              <QrScanButton
                onScanText={(text) => setUri(text)}
                onScanError={(message) => append(`qr scan: ${message}`)}
              />
            </div>
          </section>

          {contacts.length > 0 && (
            <section className="fly-card" aria-label="Recent people and places">
              <h2>People and places</h2>
              <ul className="fly-conv-list">
                {contacts.slice(0, 5).map((c) => (
                  <li key={c.name}>
                    <button onClick={() => onVisitContact(c.address)}>
                      <strong>{c.name}</strong>{' '}
                      <span className="fly-muted">{shortenAddress(c.address)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="fly-row" style={{ marginTop: 8 }}>
                <button className="fly-btn" onClick={() => onSelectView('messages')}>
                  Go to Messages
                </button>
                <button className="fly-btn" onClick={() => onSelectView('portal')}>
                  Go to Portal
                </button>
              </div>
            </section>
          )}
        </main>
      )}

      {view === 'messages' && (
        <main>
          <section className="fly-card" aria-label="Private messages">
            <h2>Messages</h2>
            <p>Private conversations. Names are petnames you chose — long addresses stay hidden.</p>
            {!selfAddress ? (
              <div className="fly-row">
                <button className="fly-btn fly-btn-primary" onClick={() => void onStartMessaging()} disabled={busy}>
                  Turn on private messages
                </button>
              </div>
            ) : (
              <div className="fly-chat">
                <div>
                  <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>Chats</h3>
                  {threads.length === 0 && (
                    <p className="fly-muted">No chats yet. Add someone below to say hello.</p>
                  )}
                  <ul className="fly-conv-list">
                    {threads.map((key) => (
                      <li key={key}>
                        <button
                          aria-current={activeThread === key}
                          onClick={() => {
                            setActiveThread(key);
                            if (key.startsWith('contact:')) {
                              setRecipient(key.slice('contact:'.length));
                            }
                          }}
                        >
                          {threadLabel(key, contacts)}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div style={{ marginTop: 12 }}>
                    <label className="fly-muted" htmlFor="msg-to">
                      Message someone new (paste their private address once, then use their name)
                    </label>
                    <input
                      id="msg-to"
                      className="fly-input"
                      style={{ marginTop: 4 }}
                      placeholder="Their private address"
                      value={recipient}
                      onChange={(e) => setRecipient(e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                </div>
                <div>
                  <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>
                    {activeThread ? threadLabel(activeThread, contacts) : 'Conversation'}
                  </h3>
                  {!activeThread && (
                    <p className="fly-muted">Pick a chat, or paste an address to start one.</p>
                  )}
                  <ul style={{ fontSize: 15, listStyle: 'none', padding: 0, margin: '0 0 12px', display: 'grid', gap: 8 }}>
                    {activeMessages.map((m, i) => (
                      <li
                        key={i}
                        style={{
                          background: 'var(--fly-bg)',
                          border: '1px solid var(--fly-line)',
                          borderRadius: 0,
                          padding: '8px 12px',
                        }}
                      >
                        <span style={{ wordBreak: 'break-word' }}>{m.text}</span>{' '}
                        {m.senderTag && (
                          <button className="fly-btn" style={{ fontSize: 13, minHeight: 36, padding: '6px 12px', marginTop: 4 }} onClick={() => void onReply(m)}>
                            Reply
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="fly-row">
                    <input
                      className="fly-input"
                      placeholder="Write a message"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      aria-label="Message"
                    />
                    <button className="fly-btn fly-btn-primary" onClick={() => void onSend()} disabled={!recipient || !draft}>
                      Send
                    </button>
                  </div>
                  <p className="fly-muted">Replies are anonymous one-time tickets — the other side never sees your address.</p>
                </div>
              </div>
            )}
          </section>

          {selfAddress && (
            <ShareCard address={selfAddress} petname={null} linkLabel="My private link" />
          )}
        </main>
      )}

      {view === 'portal' && (
        <main>
          <section
            className="fly-card"
            aria-label="Open a private link"
            style={socialService ? { display: 'none' } : undefined}
          >
            <h2>Portal</h2>
            <p>Open a private site or community. The address bar below is bound to what you see.</p>
            <div className="fly-row">
              <input
                className="fly-input"
                placeholder="Paste a private link, then press Enter"
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onGo();
                }}
                spellCheck={false}
                aria-label="Private link"
              />
              <button className="fly-btn fly-btn-primary" onClick={onGo} disabled={busy || !uri}>
                Open
              </button>
              <QrScanButton
                onScanText={(text) => setUri(text)}
                onScanError={(message) => append(`qr scan: ${message}`)}
              />
            </div>
          </section>

          {pendingInvite && (
            <section className="fly-card" aria-label="You've been invited">
              <h2>You have been invited ✓</h2>
              <p>
                <strong>{shortenAddress(pendingInvite.inviter)}</strong> invited you
                {pendingInvite.note ? <> — “{pendingInvite.note}”</> : ''}. Save them with a name you will remember.
              </p>
              <div className="fly-row">
                <input
                  className="fly-input"
                  placeholder="Save as… (a name only you see)"
                  value={petname}
                  onChange={(e) => setPetname(e.target.value)}
                  spellCheck={false}
                  aria-label="Save invite as"
                />
                <button className="fly-btn fly-btn-primary" onClick={onAcceptInvite} disabled={!petname.trim()}>
                  Save
                </button>
                <button className="fly-btn" onClick={() => setPendingInvite(null)}>
                  Dismiss
                </button>
              </div>
            </section>
          )}

          {pageHtml !== null && (
            <iframe
              sandbox=""
              title="private-site"
              srcDoc={pageHtml}
              style={{ width: '100%', height: 480, border: '1px solid var(--fly-line)', borderRadius: 0, background: '#fff', marginBottom: 12 }}
            />
          )}

          <Social
            service={socialService}
            onServiceChange={setSocialService}
            trustMap={trustMap}
            onVerdict={onVerdict}
          />
        </main>
      )}

      {view === 'service' && (
        <RunPortal onProbe={onProbePortal} busy={busy} />
      )}

      {view === 'settings' && (
        <main>
          <section className="fly-card" aria-label="Private network">
            <h2>Private network</h2>
            <p>One switch for your protection. Details live under Advanced.</p>
            <div className="fly-row">
              {status.state !== 'ready' ? (
                <button className="fly-btn fly-btn-primary" onClick={() => void onConnect()} disabled={busy}>
                  Connect privately
                </button>
              ) : (
                <button className="fly-btn" onClick={() => void onDisconnect()} disabled={busy}>
                  Switch off
                </button>
              )}
              <button className="fly-btn" onClick={() => void onProveTunnel()} disabled={busy}>
                Prove I am protected
              </button>
            </div>
            {lastError !== null && lastError !== undefined && (
              <FriendlyError error={lastError} onRetry={onConnect} retrying={busy} />
            )}
          </section>

          {selfAddress ? (
            <ShareCard address={selfAddress} petname={null} linkLabel="My private link" />
          ) : (
            <section className="fly-card" aria-label="My private link">
              <h2>My private link</h2>
              <p>Turn on private messages to get a link you can share.</p>
              <button className="fly-btn" onClick={() => void onStartMessaging()} disabled={busy}>
                Turn on private messages
              </button>
            </section>
          )}

          <section className="fly-card" aria-label="People">
            <h2>People</h2>
            <p>Names you chose for private links. Everything stays on this device.</p>
            <ContactsPanel
              contacts={contacts}
              pending={pendingInvite}
              onVisit={onVisitContact}
              onRemove={onRemoveContact}
              onAccept={onAcceptInvite}
              onDismissInvite={() => setPendingInvite(null)}
              onTrustVouched={onTrustVouched}
              petname={petname}
              onPetnameChange={setPetname}
            />
          </section>

          <section className="fly-card" aria-label="Advanced settings">
            <div className="fly-row" style={{ justifyContent: 'space-between' }}>
              <div>
                <h2 style={{ marginBottom: 0 }}>Advanced</h2>
                <p style={{ margin: '4px 0 0' }}>Technical tools. Hidden unless you need them.</p>
              </div>
              <button
                className="fly-btn"
                aria-expanded={advanced}
                onClick={() => onToggleAdvanced(!advanced)}
              >
                {advanced ? 'Hide advanced' : 'Show advanced'}
              </button>
            </div>
            {advanced && (
              <div style={{ marginTop: 16 }}>
                <Toolbar open={openPanels} onToggle={onTogglePanel} statusLabel={label} statusTone={tone} />

                {openPanels.includes('connection') && (
                  <Panel title="Connection (technical)" onClose={() => onClosePanel('connection')}>
                    <div className="fly-row">
                      <button className="fly-btn" onClick={() => void onConnect()} disabled={busy}>
                        Connect
                      </button>
                      <button className="fly-btn" onClick={() => void onProveTunnel()} disabled={busy}>
                        Prove tunnel (IP comparison)
                      </button>
                      <button className="fly-btn" onClick={() => void onDisconnect()} disabled={busy}>
                        Disconnect
                      </button>
                    </div>
                    <ul style={{ fontSize: 13 }}>
                      <li>Clearnet source IP: {clearnetIp || '—'}</li>
                      <li>Mixnet source IP: {mixnetIp || '—'}</li>
                      <li>Hop model: entry gateway → 3 mix layers → destination gateway (5 Sphinx hops)</li>
                      <li>
                        Requests on current exit: {exit.requests}
                        {exit.recommendReconnect && ' — reconnect recommended to change exit (§5.2.2)'}
                      </li>
                    </ul>
                  </Panel>
                )}

                {openPanels.includes('messages') && (
                  <Panel title="Pure mixnet messaging (Nym address + SURBs)" onClose={() => onClosePanel('messages')}>
                    <div>
                      <button className="fly-btn" onClick={() => void onStartMessaging()} disabled={busy || Boolean(selfAddress)}>
                        Start messaging client
                      </button>
                      {selfAddress && <p style={{ wordBreak: 'break-all', fontSize: 12 }}>My address: {selfAddress}</p>}
                      <div className="fly-row" style={{ marginTop: 8 }}>
                        <input
                          className="fly-input"
                          placeholder="recipient Nym address (id.enc@gw)"
                          value={recipient}
                          onChange={(e) => setRecipient(e.target.value)}
                        />
                        <input
                          className="fly-input"
                          placeholder="message"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                        />
                        <button className="fly-btn" onClick={() => void onSend()}>Send</button>
                      </div>
                      <h3 style={{ fontSize: 15 }}>Inbox</h3>
                      <ul style={{ fontSize: 13 }}>
                        {inbox.map((m, i) => (
                          <li key={i}>
                            {m.text}{' '}
                            {m.senderTag && (
                              <button className="fly-btn" onClick={() => void onReply(m)} style={{ fontSize: 11 }}>
                                reply via SURB
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </Panel>
                )}

                {openPanels.includes('fetch') && (
                  <Panel title="Private-site fetch (manual)" onClose={() => onClosePanel('fetch')}>
                    <p className="fly-muted">
                      Fetch a page from a private site by address. One call, one response —
                      no Connect needed.
                    </p>
                    <div className="fly-row" style={{ marginTop: 8 }}>
                      <input
                        className="fly-input"
                        placeholder="private-site address"
                        value={hsAddress}
                        onChange={(e) => setHsAddress(e.target.value)}
                      />
                      <input
                        className="fly-input"
                        style={{ flex: '0 1 140px', minWidth: 120 }}
                        placeholder="/path"
                        value={hsPath}
                        onChange={(e) => setHsPath(e.target.value)}
                      />
                      <button className="fly-btn" onClick={() => void onFetchNym()} disabled={busy}>
                        Fetch
                      </button>
                    </div>
                    {hsResult && (
                      <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', marginTop: 8 }}>{hsResult}</pre>
                    )}
                  </Panel>
                )}

                {openPanels.includes('log') && (
                  <Panel title="Log (technical)" onClose={() => onClosePanel('log')}>
                    <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', margin: 0 }}>{log.join('\n')}</pre>
                  </Panel>
                )}

                {openPanels.includes('contacts') && (
                  <Panel title="Contacts (technical view)" onClose={() => onClosePanel('contacts')}>
                    <ContactsPanel
                      contacts={contacts}
                      pending={pendingInvite}
                      onVisit={onVisitContact}
                      onRemove={onRemoveContact}
                      onAccept={onAcceptInvite}
                      onDismissInvite={() => setPendingInvite(null)}
                      onTrustVouched={onTrustVouched}
                      petname={petname}
                      onPetnameChange={setPetname}
                    />
                  </Panel>
                )}

                {openPanels.includes('portal') && (
                  <Panel title="Portal replica (reads)" onClose={() => onClosePanel('portal')}>
                    <PortalSync />
                  </Panel>
                )}
              </div>
            )}
          </section>
        </main>
      )}
        </div>
        <ContextPanel
          view={view}
          open={contextOpen}
          onToggle={onToggleContext}
          portalService={socialService}
          portalBound={socialService !== ''}
          inviteFrom={pendingInvite?.inviter ?? null}
          threadLabel={activeThread ? threadLabel(activeThread, contacts) : null}
          threadAddress={activeThreadAddress}
          statusLabel={label}
          statusTone={tone}
          clearnetIp={clearnetIp}
          mixnetIp={mixnetIp}
          advanced={advanced}
          onToggleAdvanced={onToggleAdvanced}
        />
      </div>
    </div>
  );
}
