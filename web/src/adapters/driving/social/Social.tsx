/**
 * nysiris community UI: identity, tabbed timeline / private messages /
 * about views, composer, profiles, sealed DMs.
 *
 * Talks to a nysiris-social provider exclusively through `fetchNym` (one shared
 * client, requests serialized — the SDK cannot correlate concurrent calls).
 * Polls the feed and the DM dead-drop on chained, non-overlapping timeouts;
 * DM dead-drop; the server keeps no follows, likes, or read receipts. The
 * About tab mirrors the provider's landing page (`DESCRIPTOR_HTML` in
 * `services/social/src/service.rs`).
 *
 * This component is now a thin orchestrator: state/handlers live in the
 * `hooks/` concern hooks, rendering in `components/`.
 */
import { useCallback, useMemo, useState } from 'react';
import { authorLabel } from '../../../application/petnameStore';
import { resolveStanding, type Verdict } from '../../../domain/trust';
import { AboutView } from './components/AboutView';
import { CommunityHeader } from './components/CommunityHeader';
import { CommunityTabs } from './components/CommunityTabs';
import { DmView } from './components/DmView';
import { PostBody, type PostBodyContext } from './components/PostBody';
import { TimelineView } from './components/TimelineView';
import { useBusy } from './hooks/useBusy';
import { useCommunityFeed } from './hooks/useCommunityFeed';
import { useCommunityTab } from './hooks/useCommunityTab';
import { useDirectMessages } from './hooks/useDirectMessages';
import { useIdentitySession } from './hooks/useIdentitySession';
import { useLog } from './hooks/useLog';
import { usePetnames } from './hooks/usePetnames';
import { usePostComposer } from './hooks/usePostComposer';
import { usePow } from './hooks/usePow';
import { useTrustedOnly } from './hooks/useTrustedOnly';
import type { Post } from './model';

export function Social({
  service,
  onServiceChange,
  trustMap,
  onVerdict,
}: {
  service: string;
  onServiceChange: (service: string) => void;
  /** Explicit Trust/Block verdicts, owned by App so invites can write them too. */
  trustMap: Record<string, Verdict>;
  onVerdict: (author: string, verdict: Verdict | null) => void;
}) {
  const { log, append } = useLog();
  const { busy, setBusy } = useBusy();
  const { powFor } = usePow();
  const { tab, onSelectTab } = useCommunityTab();
  const petnames = usePetnames();
  const { trustedOnly, toggleTrustedOnly } = useTrustedOnly();
  const feed = useCommunityFeed({ service, append, onSelectTab });
  const session = useIdentitySession({ service, trustMap, append, powFor, setBusy });
  const dms = useDirectMessages({
    service,
    identity: session.identity,
    append,
    authed: session.authed,
    powFor,
    setBusy,
  });
  const composer = usePostComposer({
    service,
    append,
    authed: session.authed,
    powFor,
    refreshFeed: feed.refreshFeed,
    onSelectTab,
    busy,
    setBusy,
  });

  // Posts collapsed by the spam gate, revealed per post id for this session.
  const [revealedBlocked, setRevealedBlocked] = useState<Record<string, boolean>>({});

  const postContext = useMemo<PostBodyContext>(
    () => ({
      service,
      trustMap,
      standingOf: feed.standingOf,
      petnameMap: petnames.petnameMap,
      names: feed.names,
      dupeAuthors: petnames.dupeAuthors,
      revealedBlocked,
      namingAuthor: petnames.namingAuthor,
      namingValue: petnames.namingValue,
      onReveal: (postId) => setRevealedBlocked((prev) => ({ ...prev, [postId]: true })),
      onLookup: feed.onLookup,
      onStartNaming: (author, current) => {
        petnames.setNamingAuthor(author);
        petnames.setNamingValue(current);
      },
      onNamingChange: petnames.setNamingValue,
      onSaveNaming: (author) => petnames.savePetname(author, petnames.namingValue),
      onClearNaming: (author) => petnames.savePetname(author, null),
      onCancelNaming: () => {
        petnames.setNamingAuthor(null);
        petnames.setNamingValue('');
      },
      onVerdict,
    }),
    [service, trustMap, feed, petnames, revealedBlocked, onVerdict],
  );

  const renderPost = useCallback((post: Post) => <PostBody post={post} ctx={postContext} />, [postContext]);

  // Timeline shows top-level posts; replies live in their threads.
  const visiblePosts = useMemo(
    () =>
      trustedOnly
        ? feed.topLevelPosts.filter(
            (p) => resolveStanding(trustMap[p.author.toLowerCase()] ?? null, feed.standingOf(p.author)) === 'trusted',
          )
        : feed.topLevelPosts,
    [trustedOnly, feed.topLevelPosts, feed.standingOf, trustMap],
  );

  const replyToLabel = composer.replyTo
    ? authorLabel(
        composer.replyTo.author,
        petnames.petnameMap[composer.replyTo.author.toLowerCase()] ?? null,
        feed.names[composer.replyTo.author] ?? null,
      )
    : null;

  // The Community section only exists while a portal is open: opening a
  // private link (Open) binds `service`, closing it unbinds. All hooks run
  // above, so this early return is safe.
  if (!service) return null;

  return (
    <section
      style={{
        border: '1px solid var(--fly-line)',
        borderRadius: 0,
        padding: 12,
        marginBottom: 12,
        background: 'var(--fly-surface)',
      }}
    >
      <CommunityHeader session={session} busy={busy} onRefresh={() => void feed.refreshFeed()} />
      <CommunityTabs tab={tab} onSelect={onSelectTab} />

      {tab === 'timeline' && (
        <TimelineView
          service={service}
          feed={feed}
          composer={composer}
          replyToLabel={replyToLabel}
          busy={busy}
          trustedOnly={trustedOnly}
          onToggleTrustedOnly={toggleTrustedOnly}
          visiblePosts={visiblePosts}
          renderPost={renderPost}
          onBeFirst={() => {
            onSelectTab('timeline');
            composer.composerRef.current?.focus();
          }}
          onError={append}
        />
      )}

      {tab === 'messages' && (
        <DmView
          service={service}
          identityPresent={session.identity !== null}
          busy={busy}
          dms={dms.dms}
          dmRead={dms.dmRead}
          activeDmPeer={dms.activeDmPeer}
          onOpenConvo={dms.openConvo}
          dmTo={dms.dmTo}
          onDmToChange={dms.setDmTo}
          dmDraft={dms.dmDraft}
          onDmDraftChange={dms.setDmDraft}
          dmFiles={dms.dmFiles}
          onDmFilesChange={dms.setDmFiles}
          onSendDm={() => void dms.onSendDm()}
          onCheckMessages={() => void dms.pollDms()}
          petnameMap={petnames.petnameMap}
          names={feed.names}
          onError={append}
        />
      )}

      {tab === 'about' && (
        <AboutView
          profileName={session.profileName}
          onProfileNameChange={session.setProfileName}
          profileBio={session.profileBio}
          onProfileBioChange={session.setProfileBio}
          onSaveProfile={() => void session.onSaveProfile()}
          busy={busy}
          log={log}
        />
      )}
    </section>
  );
}
