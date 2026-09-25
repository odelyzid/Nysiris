import { MAX_POST_BYTES } from '../../../../domain/limits';
import type { RefObject } from 'react';
import { AttachmentPicker, type PreparedAttachment } from '../attachmentUi';
import type { Post } from '../model';

/** Timeline composer: optional reply banner, text input, and attachments. */
export function TimelineComposer({
  replyTo,
  replyToLabel,
  draft,
  onDraftChange,
  onPost,
  busy,
  postFiles,
  onPostFilesChange,
  onError,
  onCancelReply,
  composerRef,
}: {
  replyTo: Post | null;
  replyToLabel: string | null;
  draft: string;
  onDraftChange: (value: string) => void;
  onPost: () => void;
  busy: boolean;
  postFiles: PreparedAttachment[];
  onPostFilesChange: (files: PreparedAttachment[]) => void;
  onError: (line: string) => void;
  onCancelReply: () => void;
  composerRef: RefObject<HTMLInputElement>;
}) {
  return (
    <>
      {replyTo && (
        <div
          style={{
            border: '1px solid #ccc',
            borderRadius: 0,
            padding: '6px 10px',
            marginBottom: 8,
            fontSize: 12,
            background: 'var(--fly-bg, #f7f5f2)',
          }}
        >
          Replying to <strong>{replyToLabel}</strong>: “{replyTo.body.slice(0, 80)}
          {replyTo.body.length > 80 ? '…' : ''}”{' '}
          <button className="fly-btn" style={{ fontSize: 11 }} onClick={onCancelReply} aria-label="Cancel reply">
            ✕
          </button>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <input
          ref={composerRef}
          style={{ flex: 1 }}
          placeholder={replyTo ? 'Write a reply…' : `Share something (max ${MAX_POST_BYTES} characters)`}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          maxLength={MAX_POST_BYTES}
          className="fly-input"
        />
        <button onClick={onPost} disabled={busy || !draft.trim()} className="fly-btn fly-btn-secondary">
          {replyTo ? 'Reply' : 'Post'}
        </button>
      </div>
      <div style={{ marginBottom: 8 }}>
        <AttachmentPicker
          files={postFiles}
          onChange={onPostFilesChange}
          onError={onError}
          disabled={busy}
          inputId="fly-attach-post"
        />
      </div>
    </>
  );
}
