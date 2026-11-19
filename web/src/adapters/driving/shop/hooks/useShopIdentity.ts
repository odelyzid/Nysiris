import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createIdentity,
  loadIdentitySecure,
  migrateIdentityToKeystore,
  persistIdentitySecure,
} from '../../../../application/identityStore';
import type { Identity } from '../../../../domain/identity';

/**
 * Restoration is process-wide: the keystore/plaintext migration should run
 * once, and every consumer must see the same async result. Without sharing the
 * promise, an early write could create a fresh key while a second load was
 * still in flight and overwrite it.
 */
let restorePromise: Promise<Identity | null> | null = null;
function restoreIdentity(): Promise<Identity | null> {
  if (!restorePromise) {
    restorePromise = (async () => {
      try {
        await migrateIdentityToKeystore();
      } catch {
        // Best-effort; the plaintext cache fallback still applies.
      }
      return await loadIdentitySecure().catch(() => null);
    })();
  }
  return restorePromise;
}

/**
 * The shop uses the same ed25519 identity as the rest of the app: the public
 * key is the account. Loading/migration mirrors the social session, but the
 * shop needs none of the profile/invite surface.
 *
 * `loaded` tells the UI when restoration is complete; `authed` also awaits it,
 * so an early click cannot mint a new key over a persisted one.
 */
export function useShopIdentity() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loaded, setLoaded] = useState(false);
  const identityRef = useRef<Identity | null>(null);

  useEffect(() => {
    let cancelled = false;
    void restoreIdentity().then((restored) => {
      if (cancelled) return;
      // An early `authed` call may already have created a key. Never replace
      // it with a null restoration result.
      if (!identityRef.current && restored) {
        identityRef.current = restored;
        setIdentity(restored);
      }
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const authed = useCallback(
    async <T,>(fn: (id: Identity) => Promise<T>): Promise<T> => {
      const restored = await restoreIdentity();
      let id = identityRef.current ?? restored;
      if (!id) {
        id = createIdentity();
        identityRef.current = id;
        setIdentity(id);
        void persistIdentitySecure(id).catch(() => undefined);
      }
      setLoaded(true);
      return fn(id);
    },
    [],
  );

  return { identity, loaded, authed };
}
