import type { AttachmentRef } from '../../../domain/attachmentCrypto';

/** A verified feed post as rendered by the community UI. */
export interface Post {
  seq: number;
  id: string;
  author: string;
  day: number;
  body: string;
  /** Parent post id (hex) for replies; null for top-level posts. */
  in_reply_to: string | null;
  /** Attachment metadata (validated + signature-bound on read). */
  attachments?: AttachmentRef[];
  sig: string;
}

export interface FeedReply {
  posts: Post[];
  next: number;
}

/** `day` (UTC day number) rendered as a short ISO date. */
export function dayLabel(day: number): string {
  return new Date(day * 86_400 * 1000).toISOString().slice(0, 10);
}
