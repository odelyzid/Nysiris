import { MAX_POST_BYTES } from '../../../../domain/limits';

/** About tab: service description, profile editor, and the technical log. */
export function AboutView({
  profileName,
  onProfileNameChange,
  profileBio,
  onProfileBioChange,
  onSaveProfile,
  busy,
  log,
}: {
  profileName: string;
  onProfileNameChange: (value: string) => void;
  profileBio: string;
  onProfileBioChange: (value: string) => void;
  onSaveProfile: () => void;
  busy: boolean;
  log: string[];
}) {
  return (
    <div role="tabpanel" id="social-panel-about" aria-label="About this community">
      <h3 className="section-title">About this community</h3>
      <p className="fly-callout-warn" role="note">
        <strong>Experimental software — pre-audit.</strong> Nysiris has not had an independent
        security audit yet; don't rely on it for high-stakes anonymity. Details:{' '}
        <code>docs/05-security.md</code>.
      </p>
      <p className="fly-prose">
        Metadata-minimal microblog + encrypted DMs, reachable only over the private network.
      </p>
      <ul className="fly-list">
        <li>
          <code>GET /feed?since=&lt;seq&gt;&amp;limit=&lt;n&gt;</code> — global chronological timeline
        </li>
        <li>
          <code>POST /post</code> — signed micro-post (max {MAX_POST_BYTES} bytes; optional <code>in_reply_to</code>{' '}
          parent id for replies)
        </li>
        <li>
          <code>GET /post/&lt;id&gt;</code> — one post by id, for filling thread gaps
        </li>
        <li>
          <code>GET /profile/&lt;pubkey&gt;</code> / <code>POST /profile</code> — self-asserted profiles
        </li>
        <li>
          <code>POST /dm</code> / <code>GET /dm?for=&lt;pubkey&gt;</code> — sealed direct messages, self-destruct on read
        </li>
      </ul>
      <p className="fly-prose">No accounts, no follows, no likes, no read receipts. Your public key is your name.</p>

      <h3 className="section-title">Your profile</h3>
      <p className="fly-meta">Self-asserted: the name and bio you set here are signed by your ID.</p>
      <div className="fly-field-row">
        <input
          className="fly-input fly-flex-1"
          placeholder="display name"
          value={profileName}
          onChange={(e) => onProfileNameChange(e.target.value)}
          maxLength={40}
        />
        <input
          className="fly-input fly-flex-2"
          placeholder="bio"
          value={profileBio}
          onChange={(e) => onProfileBioChange(e.target.value)}
          maxLength={280}
        />
        <button className="fly-btn fly-btn-primary" onClick={onSaveProfile} disabled={busy}>
          Save profile
        </button>
      </div>

      <details className="fly-details">
        <summary>Technical log</summary>
        <pre className="fly-pre fly-meta fly-mt-2">{log.join('\n')}</pre>
      </details>
      <p className="fly-meta">
        Your keys stay in this browser. Messages are sealed end-to-end; the community stores only scrambled text.
        Messages disappear after being read; the server keeps nothing else (no follows, likes, or receipts).
      </p>
    </div>
  );
}
