/**
 * Register a media/PDF session with the service-worker range bridge and return
 * the URL the media element should load. Falls back to a data/blob URL when the
 * worker is not controlling the page yet.
 */
import { useEffect, useState } from 'react';
import {
  mediaPath,
  mediaSessions,
  mediaStreamingAvailable,
  type MediaDescriptor,
} from '../../../application/mediaSession';

export function useStreamUrl(
  descriptor: Omit<MediaDescriptor, 'url' | 'title'> & { url: string | null; title?: string },
  fallback: string,
): string {
  const [url, setUrl] = useState(fallback);
  const { url: documentUrl, contentType, total, etag, title = '' } = descriptor;

  useEffect(() => {
    if (!documentUrl || !mediaStreamingAvailable()) {
      setUrl(fallback);
      return;
    }
    const session = mediaSessions.register({ url: documentUrl, contentType, total, etag, title });
    setUrl(mediaPath(session.token));
    return () => mediaSessions.unregister(session.token);
  }, [documentUrl, contentType, total, etag, title, fallback]);

  return url;
}
