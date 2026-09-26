import {
  STANDING_META,
  cautionFor,
  resolveStanding,
  shouldCollapse,
  standingTitle,
  type Standing,
  type Verdict,
} from '../../../../domain/trust';
import { authorLabel } from '../../../../application/petnameStore';
import { AttachmentList } from '../attachmentUi';
import { dayLabel, type Post } from '../model';

/** State + handlers shared by every rendered post body. */
export interface PostBodyContext {
  service: string;
  trustMap: Record<string, Verdict>;
  /** First-hand observed standing for an author (from the local reputation store). */
  standingOf: (author: string) => Standing;
  petnameMap: Record<string, string>;
  names: Record<string, string>;
  dupeAuthors: Set<string>;
  revealedBlocked: Record<string, boolean>;
  namingAuthor: string | null;
  namingValue: string;
  onReveal: (postId: string) => void;
  onLookup: (author: string) => void;
  onStartNaming: (author: string, current: string) => void;
  onNamingChange: (value: string) => void;
  onSaveNaming: (author: string) => void;
  onClearNaming: (author: string) => void;
  onCancelNaming: () => void;
  onVerdict: (author: string, verdict: Verdict | null) => void;
}

/** Trust dot + author header + body + attachments + caution for one post. */
export function PostBody({ post: p, ctx }: { post: Post; ctx: PostBodyContext }) {
  const observed = ctx.standingOf(p.author);
  const explicit = ctx.trustMap[p.author.toLowerCase()] ?? null;
  const standing = resolveStanding(explicit, observed);
  const meta = STANDING_META[standing];
  const petname = ctx.petnameMap[p.author.toLowerCase()] ?? null;
  const profileName = ctx.names[p.author] ?? null;
  const isNaming = ctx.namingAuthor === p.author;

  if (shouldCollapse(standing) && !ctx.revealedBlocked[p.id]) {
    return (
      <div>
        <span
          title={standingTitle(standing, explicit !== null)}
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: meta.color,
            marginRight: 6,
          }}
        />
        <strong>{authorLabel(p.author, petname, profileName)}</strong>{' '}
        <span style={{ color: 'var(--fly-muted)' }}>{dayLabel(p.day)}</span>{' '}
        <span style={{ fontSize: 12, color: 'var(--fly-muted)' }}>Blocked author — post hidden.</span>{' '}
        <button className="fly-btn" style={{ fontSize: 11 }} onClick={() => ctx.onReveal(p.id)}>
          Show anyway
        </button>
      </div>
    );
  }

  const caution = cautionFor(standing);
  return (
    <>
      <span
        title={standingTitle(standing, explicit !== null)}
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: meta.color,
          marginRight: 6,
        }}
      />
      <strong>{authorLabel(p.author, petname, profileName)}</strong>
      {ctx.dupeAuthors.has(p.author.toLowerCase()) && (
        <span
          style={{ fontSize: 11, color: 'var(--fly-muted)' }}
          title="Same name as another author — the hex tells them apart"
        >
          {' '}
          ·{p.author.slice(0, 8)}…
        </span>
      )}{' '}
      <span style={{ color: 'var(--fly-muted)' }}>{dayLabel(p.day)}</span>{' '}
      {!profileName && !petname && !isNaming && (
        <>
          <button className="fly-btn" style={{ fontSize: 11 }} onClick={() => ctx.onLookup(p.author)}>
            who?
          </button>{' '}
        </>
      )}
      {!isNaming ? (
        <button
          className="fly-btn"
          style={{ fontSize: 11 }}
          title="Give them a name only you see"
          onClick={() => ctx.onStartNaming(p.author, petname ?? '')}
        >
          Name
        </button>
      ) : (
        <span>
          <input
            className="fly-input"
            style={{ width: 140, fontSize: 12 }}
            placeholder="name only you see"
            value={ctx.namingValue}
            onChange={(e) => ctx.onNamingChange(e.target.value)}
            maxLength={40}
            spellCheck={false}
            aria-label="Petname for this author"
          />{' '}
          <button className="fly-btn" style={{ fontSize: 11 }} onClick={() => ctx.onSaveNaming(p.author)}>
            Save
          </button>{' '}
          {petname && (
            <button className="fly-btn" style={{ fontSize: 11 }} onClick={() => ctx.onClearNaming(p.author)}>
              Clear
            </button>
          )}{' '}
          <button className="fly-btn" style={{ fontSize: 11 }} onClick={() => ctx.onCancelNaming()}>
            Cancel
          </button>
        </span>
      )}{' '}
      {explicit === null ? (
        <>
          <button
            className="fly-btn"
            style={{ fontSize: 11 }}
            title="Always show them as trusted"
            onClick={() => ctx.onVerdict(p.author, 'trusted')}
          >
            Trust
          </button>{' '}
          <button
            className="fly-btn"
            style={{ fontSize: 11 }}
            title="Always show them as blocked"
            onClick={() => ctx.onVerdict(p.author, 'blocked')}
          >
            Block
          </button>
        </>
      ) : (
        <button
          className="fly-btn"
          style={{ fontSize: 11 }}
          title="Back to first-hand observations"
          onClick={() => ctx.onVerdict(p.author, null)}
        >
          Undo {explicit === 'trusted' ? 'trust' : 'block'}
        </button>
      )}
      <div style={{ wordBreak: 'break-word' }}>{p.body}</div>
      {p.attachments && p.attachments.length > 0 && <AttachmentList service={ctx.service} refs={p.attachments} />}
      {caution && (
        <div style={{ fontSize: 11, color: 'var(--fly-warn)', marginTop: 4 }} role="note">
          ⚠ {caution}.
        </div>
      )}
    </>
  );
}
