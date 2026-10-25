import { MAX_POST_BYTES } from '../../../../domain/limits';
import type { RefObject } from 'react';
import { CloseIcon } from '../../shared/icons';
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
        <div className="fly-reply-banner">
          Replying to <strong>{replyToLabel}</strong>: “{replyTo.body.slice(0, 80)}
          {replyTo.body.length > 80 ? '…' : ''}”{' '}
          <button className="fly-btn fly-btn-sm fly-icon-btn" onClick={onCancelReply} aria-label="Cancel reply" title="Cancel reply">
            <CloseIcon size={14} />
          </button>
        </div>
      )}
      <div className="fly-composer-row">
        <input
          ref={composerRef}
          style={{ flex: 1 }}
          placeholder={replyTo ? 'Write a reply…' : `Share something (max ${MAX_POST_BYTES} characters)`}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          maxLength={MAX_POST_BYTES}
          className="fly-input"
        />
        <button onClick={onPost} disabled={busy || !draft.trim()} className="btn btn-primary">
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
