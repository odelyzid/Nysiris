/**
 * Portal workspace surface: local-first feed/wiki/profile over the signed
 * replica, with per-portal authoring, trust decisions, and conflict recovery.
 *
 * Reads render immediately from IndexedDB; Sync is explicit. Publishing uses a
 * fresh key per portal and only updates the local replica after the provider
 * accepts the object and log entry.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { defaultStorage } from '../../../lib/storage';
import {
  defaultPortalContentStore,
  emptyReplica,
  loadScopedReplica,
  saveScopedReplica,
} from '../../../application/portalStore';
import {
  dismissLegacyMigration,
  legacyMigrationDismissed,
  legacyReplicaSummary,
  migrateLegacyReplica,
  type LegacyReplicaSummary,
} from '../../../application/portalMigration';
import { isOnline } from '../../../pwa';
import {
  PORTAL_SYNC_BASE_MS,
  isPortalSyncDue,
  portalSyncBlocked,
  portalSyncDelay,
} from '../../../application/portalScheduler';
import { syncPortalReplica } from '../../driven/portalSyncIo';
import { publishPortalContent } from '../../driven/portalWriteIo';
import { buildPortalView } from '../../../application/portalView';
import {
  PortalTrustStore,
  loadPortalTrust,
  savePortalTrust,
  type PortalVerdict,
} from '../../../application/portalTrust';
import {
  emptyWorkspace,
  findWorkspace,
  loadPortalWorkspaces,
  normalisePortalScope,
  portalTransportAddress,
  saveActiveWorkspaceId,
  savePortalWorkspaces,
  upsertWorkspace,
  type PortalWorkspace as PortalWorkspaceRecord,
} from '../../../application/portalWorkspaces';
import { createPortalAuthor, loadPortalAuthor } from '../../../application/portalIdentity';
import { PORTAL_KINDS, parsePortalContent, type GenericObjectContent } from '../../../domain/portalContent';
import { applyPortalBundle } from '../../../domain/portalWrite';
import { b64decode } from '../../../lib/bytes';
import { resetAuthorLog, type PortalSyncIssue } from '../../../application/portalConflict';
import type { PortalReplica } from '../../../domain/portalSync';
import type { Identity } from '../../../domain/identity';
import { shortenAddress } from '../../../shared/share';
import { PortalMarkdown } from './PortalMarkdown';

export function PortalWorkspace({
  scope: rawScope,
  onOpenLink,
  onOpenWorkspace,
  onStatus,
}: {
  scope: string;
  onOpenLink: (href: string) => void;
  onOpenWorkspace?: (scope: string) => void;
  onStatus?: (message: string) => void;
}) {
  const scope = normalisePortalScope(rawScope);
  const transport = portalTransportAddress(scope);
  const storeRef = useRef(defaultPortalContentStore(defaultStorage()));
  const [workspaces, setWorkspaces] = useState(() => loadPortalWorkspaces(defaultStorage()).workspaces);
  const [replica, setReplica] = useState<PortalReplica>(() => emptyReplica());
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [trust] = useState<PortalTrustStore>(() => loadPortalTrust(defaultStorage()));
  const [trustVersion, setTrustVersion] = useState(0);
  const [issues, setIssues] = useState<PortalSyncIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');
  const [body, setBody] = useState('');
  const [wikiSlug, setWikiSlug] = useState('');
  const [profileName, setProfileName] = useState('');
  const [profileBio, setProfileBio] = useState('');
  const [wikiSlugInput, setWikiSlugInput] = useState('');
  const [wikiTitle, setWikiTitle] = useState('');
  const [wikiBody, setWikiBody] = useState('');
  const [legacy, setLegacy] = useState<LegacyReplicaSummary | null>(null);
  const [migrating, setMigrating] = useState(false);
  const syncingRef = useRef(false);
  const failuresRef = useRef(0);
  const lastSyncedRef = useRef<number | null>(null);
  const syncFnRef = useRef<(() => Promise<void>) | null>(null);

  const workspace = findWorkspace(workspaces, scope) ?? emptyWorkspace(scope);
  lastSyncedRef.current = workspace.lastSyncedAt;
  const view = useMemo(() => buildPortalView(replica, { trust, scope }), [replica, trust, scope, trustVersion]);
  const selectedWiki = view.wiki.find((page) => page.slug === wikiSlug) ?? view.wiki[0] ?? null;

  useEffect(() => {
    if (!view.profile) return;
    setProfileName((current) => current || view.profile?.name || '');
    setProfileBio((current) => current || view.profile?.bio || '');
  }, [view.profile?.name, view.profile?.bio]);

  useEffect(() => {
    if (!selectedWiki) return;
    setWikiSlugInput(selectedWiki.slug);
    setWikiTitle(selectedWiki.title);
    setWikiBody(selectedWiki.markdown);
  }, [selectedWiki?.slug]);

  const rememberWorkspace = (patch: Partial<PortalWorkspaceRecord>) => {
    setWorkspaces((prev) => {
      const current = findWorkspace(prev, scope) ?? emptyWorkspace(scope);
      const next = upsertWorkspace(prev, { ...current, ...patch });
      savePortalWorkspaces(defaultStorage(), { version: 1, activeId: scope, workspaces: next });
      saveActiveWorkspaceId(defaultStorage(), scope);
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setIssues([]);
    setWikiSlug('');
    void (async () => {
      const loaded = (await loadScopedReplica(storeRef.current, scope)) ?? emptyReplica();
      if (cancelled) return;
      setReplica(loaded);
      const hasData =
        Object.keys(loaded.objectsById).length > 0 ||
        Object.values(loaded.entriesByAuthor).some((entries) => entries.length > 0);
      setLegacy(
        !hasData && !legacyMigrationDismissed(defaultStorage()) ? legacyReplicaSummary(defaultStorage()) : null,
      );
      setIdentity(loadPortalAuthor(defaultStorage(), scope));
      const state = loadPortalWorkspaces(defaultStorage());
      const existing = findWorkspace(state.workspaces, scope);
      if (!existing) {
        const created = emptyWorkspace(scope);
        const next = upsertWorkspace(state.workspaces, created);
        savePortalWorkspaces(defaultStorage(), { version: 1, activeId: scope, workspaces: next });
        setWorkspaces(next);
      } else {
        setWorkspaces(state.workspaces);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const onSync = async () => {
    if (syncing || syncingRef.current) return;
    setSyncing(true);
    syncingRef.current = true;
    setError('');
    try {
      const { replica: next, summary } = await syncPortalReplica(transport, replica, {
        timeoutMs: 120_000,
        storage: null,
      });
      setReplica(next);
      setIssues(summary.issues);
      failuresRef.current = 0;
      await saveScopedReplica(storeRef.current, scope, next, defaultStorage());
      const model = buildPortalView(next, { trust, scope });
      rememberWorkspace({
        title: model.siteIndex?.title ?? model.profile?.name ?? workspace.title,
        lastSyncedAt: Date.now(),
      });
      setLegacy(null);
      onStatus?.(`Portal updated: ${summary.authors} authors, ${summary.objects} new objects`);
    } catch (err) {
      failuresRef.current += 1;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  };
  syncFnRef.current = onSync;

  // Background replication while the app is open: timer + visibility/online
  // wakeups, paused while offline/hidden/in-flight. Only followed workspaces
  // that have synced at least once are polled.
  useEffect(() => {
    if (workspace.followState !== 'following' || (workspace.lastSyncedAt === null && view.authors.length === 0)) {
      return;
    }
    let cancelled = false;
    let timer = 0;
    const attempt = async () => {
      if (cancelled) return;
      if (
        !portalSyncBlocked(isOnline(), typeof document !== 'undefined' && document.hidden, syncingRef.current) &&
        (lastSyncedRef.current === null || isPortalSyncDue(lastSyncedRef.current, Date.now(), failuresRef.current))
      ) {
        await syncFnRef.current?.();
      }
      schedule();
    };
    const schedule = () => {
      if (cancelled) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(attempt, portalSyncDelay(failuresRef.current));
    };
    const wake = () => {
      if (document.hidden) return;
      if (lastSyncedRef.current === null || isPortalSyncDue(lastSyncedRef.current, Date.now(), failuresRef.current)) {
        window.clearTimeout(timer);
        timer = window.setTimeout(attempt, 1_000);
      }
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    if (workspace.lastSyncedAt === null || isPortalSyncDue(lastSyncedRef.current, Date.now(), failuresRef.current)) {
      timer = window.setTimeout(attempt, 1_000);
    } else {
      schedule();
    }
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [scope, workspace.followState, workspace.lastSyncedAt, view.authors.length]);

  const ensureIdentity = (): Identity => {
    const existing = identity ?? createPortalAuthor(defaultStorage(), scope);
    if (!identity) {
      setIdentity(existing);
      rememberWorkspace({ identityPub: existing.pubHex });
    }
    return existing;
  };

  const onCreateIdentity = () => {
    try {
      ensureIdentity();
      onStatus?.('Created a fresh signing key for this portal');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const publishContent = async (
    kind: string,
    content: Parameters<typeof publishPortalContent>[3],
    success: string,
  ): Promise<boolean> => {
    if (publishing) return false;
    setPublishing(true);
    setError('');
    try {
      const author = ensureIdentity();
      const result = await publishPortalContent(transport, author, kind, content, replica, {
        timeoutMs: 120_000,
      });
      const next = applyPortalBundle(replica, result.bundle);
      setReplica(next);
      await saveScopedReplica(storeRef.current, scope, next, defaultStorage());
      rememberWorkspace({ identityPub: author.pubHex, lastSyncedAt: Date.now() });
      onStatus?.(`${success} (seq ${result.seq})`);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setPublishing(false);
    }
  };

  const onPublish = async () => {
    if (!body.trim()) return;
    const ok = await publishContent(
      PORTAL_KINDS.post,
      { version: 1, body: body.trim(), replyTo: null, attachments: [] },
      'Published post',
    );
    if (ok) setBody('');
  };

  const onPublishProfile = async () => {
    if (!profileName.trim()) return;
    await publishContent(
      PORTAL_KINDS.profile,
      { version: 1, name: profileName.trim(), bio: profileBio.trim(), avatarId: null },
      'Updated profile',
    );
  };

  const onPublishWiki = async () => {
    const slug = wikiSlugInput.trim().toLowerCase();
    if (!slug || !wikiTitle.trim() || !wikiBody.trim()) return;
    const ok = await publishContent(
      PORTAL_KINDS.wikiPage,
      { version: 1, slug, title: wikiTitle.trim(), markdown: wikiBody },
      'Published wiki page',
    );
    if (ok) setWikiSlug(slug);
  };

  const onToggleFollow = () => {
    rememberWorkspace({
      followState: workspace.followState === 'following' ? 'paused' : 'following',
      lastSyncedAt: workspace.lastSyncedAt,
    });
  };

  const onImportLegacy = async () => {
    if (migrating) return;
    setMigrating(true);
    setError('');
    try {
      const result = await migrateLegacyReplica(defaultStorage(), storeRef.current, scope, replica);
      setReplica(result.replica);
      setLegacy(null);
      if (!result.imported) setError(result.reason ?? 'Legacy replica was not imported.');
      else onStatus?.('Imported the old global portal replica into this workspace');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMigrating(false);
    }
  };

  const onDismissLegacy = () => {
    dismissLegacyMigration(defaultStorage());
    setLegacy(null);
  };

  const onTrust = (author: string, verdict: PortalVerdict) => {
    trust.set(scope, author, trust.get(scope, author) === verdict ? 'neutral' : verdict);
    savePortalTrust(defaultStorage(), trust);
    setTrustVersion((value) => value + 1);
  };

  const onResetAuthor = async (author: string) => {
    const result = resetAuthorLog(replica, author);
    setReplica(result.replica);
    setIssues((prev) => prev.filter((issue) => issue.author !== author));
    await saveScopedReplica(storeRef.current, scope, result.replica, defaultStorage());
    onStatus?.(`Reset local log for ${shortenAddress(author)}; sync to re-fetch from a provider`);
  };

  return (
    <section className="fly-card fly-portal-workspace" aria-label="Portal workspace">
      <div className="fly-row fly-row-between">
        <div>
          <h2 className="fly-h2-flush">{view.siteIndex?.title ?? view.profile?.name ?? 'Portal workspace'}</h2>
          <p className="fly-muted fly-break-all">{shortenAddress(scope)}</p>
        </div>
        <div className="fly-row fly-workspace-actions">
          <button type="button" className="fly-btn fly-btn-sm" onClick={() => void onSync()} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
          <button
            type="button"
            className={
              workspace.followState === 'following' ? 'fly-btn fly-btn-sm fly-btn-secondary' : 'fly-btn fly-btn-sm'
            }
            aria-pressed={workspace.followState === 'following'}
            onClick={onToggleFollow}
            title="Poll this workspace while the app is open"
          >
            {workspace.followState === 'following' ? 'Auto-sync on' : 'Auto-sync off'}
          </button>
          <button type="button" className="fly-btn fly-btn-sm" onClick={onCreateIdentity} disabled={Boolean(identity)}>
            {identity ? 'Author key ready' : 'Create author key'}
          </button>
        </div>
      </div>

      {legacy && (
        <div className="fly-callout-warn fly-legacy-migration" role="note">
          <p>
            Found an old global portal replica ({legacy.authors} authors, {legacy.entries} entries, {legacy.objects}{' '}
            objects) from before workspaces. Import it into this portal?
          </p>
          <div className="fly-row">
            <button
              type="button"
              className="fly-btn fly-btn-sm"
              onClick={() => void onImportLegacy()}
              disabled={migrating}
            >
              {migrating ? 'Importing…' : 'Import into this workspace'}
            </button>
            <button type="button" className="fly-btn fly-btn-sm" onClick={onDismissLegacy}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {workspaces.length > 1 && onOpenWorkspace && (
        <div className="fly-row fly-workspace-switcher" aria-label="Portal workspaces">
          {workspaces.map((item) => (
            <button
              key={item.scope}
              type="button"
              className={item.scope === scope ? 'fly-btn fly-btn-sm fly-btn-secondary' : 'fly-btn fly-btn-sm'}
              aria-pressed={item.scope === scope}
              onClick={() => onOpenWorkspace(item.scope)}
              title={item.scope}
            >
              {item.title || shortenAddress(item.scope)}
            </button>
          ))}
        </div>
      )}

      {loading && <p className="fly-muted">Reading the local replica…</p>}
      {error && (
        <p className="fly-callout-warn" role="alert">
          {error}
        </p>
      )}

      {issues.length > 0 && (
        <div className="fly-conflict-list" role="alert">
          <h3 className="fly-h3">Sync conflicts</h3>
          {issues.map((issue) => (
            <div key={issue.author} className="fly-conflict-row">
              <p>
                <strong>{shortenAddress(issue.author)}</strong> was not merged ({issue.kind}): {issue.detail}
              </p>
              <button type="button" className="fly-btn fly-btn-sm" onClick={() => void onResetAuthor(issue.author)}>
                Reset this author log
              </button>
            </div>
          ))}
        </div>
      )}

      {view.siteIndex && <p className="fly-muted fly-workspace-description">{view.siteIndex.description}</p>}
      {view.profile?.bio && (
        <div className="fly-portal-profile">
          <strong>{view.profile.name}</strong>
          <PortalMarkdown text={view.profile.bio} onOpenLink={onOpenLink} />
        </div>
      )}

      <details className="fly-workspace-form">
        <summary>Edit profile</summary>
        <div className="fly-row fly-mt-2">
          <input
            className="fly-input"
            value={profileName}
            onChange={(event) => setProfileName(event.target.value)}
            placeholder="Display name"
            aria-label="Portal display name"
          />
        </div>
        <textarea
          className="fly-input fly-workspace-editor fly-mt-2"
          value={profileBio}
          onChange={(event) => setProfileBio(event.target.value)}
          placeholder="Short bio (Markdown allowed)"
          rows={2}
          aria-label="Portal profile bio"
        />
        <button
          type="button"
          className="fly-btn fly-btn-primary fly-btn-sm fly-mt-2"
          onClick={() => void onPublishProfile()}
          disabled={publishing || !profileName.trim()}
        >
          Publish profile
        </button>
      </details>

      <div className="fly-workspace-compose">
        <textarea
          className="fly-input fly-workspace-editor"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Write a portal post…"
          rows={3}
          aria-label="Portal post body"
        />
        <div className="fly-row fly-mt-2">
          <button
            type="button"
            className="fly-btn fly-btn-primary fly-btn-sm"
            onClick={() => void onPublish()}
            disabled={publishing || !body.trim()}
          >
            {publishing ? 'Publishing…' : 'Publish post'}
          </button>
          <span className="fly-muted">Signed with this portal's author key; sync first on another device.</span>
        </div>
      </div>

      <h3 className="fly-h3">Feed</h3>
      {view.posts.length === 0 ? (
        <p className="fly-muted">Nothing in the local feed yet.</p>
      ) : (
        <ul className="fly-plain-list">
          {view.posts.map((post) => (
            <li key={post.id} className="fly-portal-post">
              <PortalMarkdown text={post.body} onOpenLink={onOpenLink} />
              {post.attachments.length > 0 && (
                <div className="fly-row fly-portal-attachments">
                  {post.attachments.map((id) => {
                    const attachment = attachmentContent(replica, id);
                    return attachment ? (
                      <button
                        key={id}
                        type="button"
                        className="fly-btn fly-btn-sm"
                        onClick={() => saveGenericObject(attachment)}
                        title={attachment.contentType}
                      >
                        {attachment.name}
                      </button>
                    ) : (
                      <span key={id} className="fly-muted">
                        missing attachment {shortenAddress(id)}
                      </span>
                    );
                  })}
                </div>
              )}
              <span className="fly-muted">
                {shortenAddress(post.author)} · seq {post.seq}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="fly-h3">Wiki</h3>
      {view.wiki.length === 0 ? (
        <p className="fly-muted">No wiki pages in the local replica.</p>
      ) : (
        <>
          <div className="fly-row">
            {view.wiki.map((page) => (
              <button
                key={page.slug}
                type="button"
                className={
                  page.slug === selectedWiki?.slug ? 'fly-btn fly-btn-sm fly-btn-secondary' : 'fly-btn fly-btn-sm'
                }
                aria-pressed={page.slug === selectedWiki?.slug}
                onClick={() => {
                  setWikiSlug(page.slug);
                  setWikiSlugInput(page.slug);
                  setWikiTitle(page.title);
                  setWikiBody(page.markdown);
                }}
              >
                {page.title}
              </button>
            ))}
          </div>
          {selectedWiki && (
            <article className="fly-portal-wiki">
              <PortalMarkdown text={selectedWiki.markdown} onOpenLink={onOpenLink} />
            </article>
          )}
        </>
      )}

      <details className="fly-workspace-form">
        <summary>{selectedWiki ? `Edit “${selectedWiki.title}”` : 'Write a wiki page'}</summary>
        <div className="fly-row fly-mt-2">
          <input
            className="fly-input"
            value={wikiSlugInput}
            onChange={(event) => setWikiSlugInput(event.target.value)}
            placeholder="slug (a-z0-9_-)"
            aria-label="Wiki page slug"
          />
          <input
            className="fly-input"
            value={wikiTitle}
            onChange={(event) => setWikiTitle(event.target.value)}
            placeholder="Page title"
            aria-label="Wiki page title"
          />
        </div>
        <textarea
          className="fly-input fly-workspace-editor fly-mt-2"
          value={wikiBody}
          onChange={(event) => setWikiBody(event.target.value)}
          placeholder="Markdown page body"
          rows={5}
          aria-label="Wiki page body"
        />
        <div className="fly-row fly-mt-2">
          <button
            type="button"
            className="fly-btn fly-btn-primary fly-btn-sm"
            onClick={() => void onPublishWiki()}
            disabled={publishing || !wikiSlugInput.trim() || !wikiTitle.trim() || !wikiBody.trim()}
          >
            Publish wiki page
          </button>
          <button
            type="button"
            className="fly-btn fly-btn-sm"
            onClick={() => {
              setWikiSlugInput('');
              setWikiTitle('');
              setWikiBody('');
            }}
          >
            New page
          </button>
        </div>
      </details>

      {view.objects.length > 0 && (
        <details className="fly-portal-objects">
          <summary>Objects ({view.objects.length})</summary>
          <ul className="fly-plain-list">
            {view.objects.map((entry) => {
              const content = entry.content;
              const name = 'name' in content ? content.name : entry.id;
              const type = 'contentType' in content ? content.contentType : entry.kind;
              return (
                <li key={entry.id} className="fly-portal-object-row">
                  <span>
                    <strong className="fly-break-word">{name}</strong>
                    <span className="fly-muted">
                      {type} · {shortenAddress(entry.author)}
                    </span>
                  </span>
                  {'dataBase64' in content && (
                    <button type="button" className="fly-btn fly-btn-sm" onClick={() => saveGenericObject(content)}>
                      Save offline
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}

      <div className="fly-row fly-row-between fly-mt-3">
        <span className="fly-muted">
          {view.authors.length} author{view.authors.length === 1 ? '' : 's'} · {view.objects.length} object
          {view.objects.length === 1 ? '' : 's'} · {view.unknown} unreadable
        </span>
        <span className="fly-muted">
          {workspace.lastSyncedAt ? `Last sync ${new Date(workspace.lastSyncedAt).toLocaleString()}` : 'Never synced'}
        </span>
      </div>

      {view.authors.length > 0 && (
        <ul className="fly-plain-list fly-portal-authors">
          {view.authors.map(({ author, entries, objects }) => {
            const verdict = trust.get(scope, author);
            return (
              <li key={author} className="fly-portal-author-row">
                <span>
                  {shortenAddress(author)} · {entries} entries · {objects} objects
                </span>
                <span className="fly-row fly-portal-author-actions">
                  <button
                    type="button"
                    className={verdict === 'trusted' ? 'fly-btn fly-btn-sm fly-btn-secondary' : 'fly-btn fly-btn-sm'}
                    aria-pressed={verdict === 'trusted'}
                    onClick={() => onTrust(author, 'trusted')}
                  >
                    Trust
                  </button>
                  <button
                    type="button"
                    className={verdict === 'blocked' ? 'fly-btn fly-btn-sm fly-btn-secondary' : 'fly-btn fly-btn-sm'}
                    aria-pressed={verdict === 'blocked'}
                    onClick={() => onTrust(author, 'blocked')}
                  >
                    Block
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function saveGenericObject(content: GenericObjectContent): void {
  const bytes = b64decode(content.dataBase64);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: content.contentType || 'application/octet-stream' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = content.name || 'attachment';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

function attachmentContent(replica: PortalReplica, id: string): GenericObjectContent | null {
  const object = replica.objectsById[id];
  if (!object) return null;
  const content = parsePortalContent(object.kind, object.payload);
  return content && 'dataBase64' in content ? content : null;
}
