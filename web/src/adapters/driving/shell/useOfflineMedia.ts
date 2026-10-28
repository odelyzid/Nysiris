/**
 * Load a previously saved media/PDF from the offline cache.
 * Returns a blob URL plus a refresh callback after a new save.
 */
import { useCallback, useEffect, useState } from 'react';
import { defaultMediaCache, mediaBlobUrl } from '../../../application/portalMediaCache';

export function useOfflineMedia(url: string | null): { url: string; refresh: () => void } {
  const [blobUrl, setBlobUrl] = useState('');
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    let created = '';
    if (!url) {
      setBlobUrl('');
      return;
    }
    void defaultMediaCache()
      .load(url)
      .then((media) => {
        if (!media || !active) return;
        created = mediaBlobUrl(media);
        setBlobUrl(created);
      })
      .catch(() => {});
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [url, version]);

  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  return { url: blobUrl, refresh };
}
