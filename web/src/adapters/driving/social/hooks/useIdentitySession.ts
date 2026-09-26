import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  BACKUP_MIN_PASSWORD_LENGTH,
  MAX_INVITE_VOUCHES,
  createIdentity,
  currentDay,
  exportIdentityBackup,
  importIdentity,
  importIdentityBackup,
  loadIdentitySecure,
  migrateIdentityToKeystore,
  persistIdentitySecure,
  signInvite,
  signProfile,
  type Identity,
} from '../../../../application/identityStore';
import { JSON_HEADERS, buildProfileRequest } from '../../../../domain/api';
import { fetchNym } from '../../../../mixnet/fetchNym';
import { encodeInviteCompact } from '../../../../mixnet/hiddenService.mjs';
import { copyText } from '../../../../shared/share';
import type { Verdict } from '../../../../domain/trust';
import { useQrCode } from '../../shared/useQrCode';
import type { PowFor } from './usePow';

export type Authed = <T>(fn: (id: Identity) => Promise<T>) => Promise<T | null>;

export interface IdentitySession {
  identity: Identity | null;
  authed: Authed;
  importKey: string;
  setImportKey: (value: string) => void;
  profileName: string;
  setProfileName: (value: string) => void;
  profileBio: string;
  setProfileBio: (value: string) => void;
  backupPw: string;
  setBackupPw: (value: string) => void;
  restorePw: string;
  setRestorePw: (value: string) => void;
  restoreFile: File | null;
  setRestoreFile: (file: File | null) => void;
  restoreFileRef: RefObject<HTMLInputElement>;
  idCopied: boolean;
  showIdQr: boolean;
  showSecret: boolean;
  secretCopied: boolean;
  showIdentity: boolean;
  vouchOnCopy: boolean;
  setVouchOnCopy: (value: boolean) => void;
  idQrUrl: string | null;
  trustedVouches: string[];
  onCreateIdentity: () => void;
  onNewIdentity: () => void;
  onImportIdentity: () => void;
  onCopyId: () => void;
  onToggleIdQr: () => void;
  onRevealSecret: () => void;
  onCopySecret: () => void;
  onHideSecret: () => void;
  onExportBackup: () => Promise<void>;
  onRestoreBackup: () => Promise<void>;
  onSaveProfile: () => Promise<void>;
  onToggleIdentity: () => void;
  onCopyInvite: () => void;
}

/**
 * Identity lifecycle (create/import/backup/restore/profile), the local QR
 * for the public ID, and the signed invite link. Keys never leave the
 * device; persistence is handled by `application/identityStore`.
 */
export function useIdentitySession({
  service,
  trustMap,
  append,
  powFor,
  setBusy,
}: {
  service: string;
  trustMap: Record<string, Verdict>;
  append: (line: string) => void;
  powFor: PowFor;
  setBusy: (value: boolean) => void;
}): IdentitySession {
  const [identity, setIdentity] = useState<Identity | null>(null);

  // The Keystore is authoritative when reachable: migrate the plaintext cache
  // once, then prefer the secure load (wrapped cache on Android, plain on
  // desktop). Runs after first paint; the session starts without an identity
  // for one tick when the Keystore holds it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await migrateIdentityToKeystore();
      } catch {
        // Best-effort; the cache fallback below still applies.
      }
      const restored = await loadIdentitySecure().catch(() => null);
      if (restored && !cancelled) setIdentity(restored);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const [importKey, setImportKey] = useState('');
  const [profileName, setProfileName] = useState('');
  const [profileBio, setProfileBio] = useState('');
  const [backupPw, setBackupPw] = useState('');
  const [restorePw, setRestorePw] = useState('');
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const restoreFileRef = useRef<HTMLInputElement | null>(null);
  const [idCopied, setIdCopied] = useState(false);
  const [showIdQr, setShowIdQr] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);
  const [showIdentity, setShowIdentity] = useState(false);
  const [vouchOnCopy, setVouchOnCopy] = useState(false);

  const authed = useCallback<Authed>(
    async (fn) => {
      const id = identity ?? createIdentity();
      if (!identity) void persistIdentitySecure(id).catch(() => undefined);
      setIdentity(id);
      return fn(id);
    },
    [identity],
  );

  /** Explicit-trust list (capped) offered as signed vouches on the invite. */
  const trustedVouches = useMemo(
    () =>
      Object.entries(trustMap)
        .filter(([, v]) => v === 'trusted')
        .map(([author]) => author)
        .slice(0, MAX_INVITE_VOUCHES),
    [trustMap],
  );

  // Local QR for your public ID: generated on this device, never uploaded.
  const { url: idQrUrl } = useQrCode(showIdQr, identity ? identity.pubHex : null);

  /** Adopt an identity into state and push it to the Keystore when reachable. */
  const adoptIdentity = useCallback(
    (id: Identity) => {
      setIdentity(id);
      void persistIdentitySecure(id)
        .then(({ keystore }) => {
          if (keystore) append('identity secured in the device keystore');
        })
        .catch(() => undefined);
    },
    [append],
  );

  const onCreateIdentity = useCallback(() => {
    adoptIdentity(createIdentity());
    append('new identity generated');
  }, [adoptIdentity, append]);

  const onNewIdentity = useCallback(() => {
    adoptIdentity(createIdentity());
    setIdCopied(false);
    setShowIdQr(false);
    append('new identity generated');
  }, [adoptIdentity, append]);

  const onImportIdentity = useCallback(() => {
    try {
      adoptIdentity(importIdentity(importKey));
      setImportKey('');
      append('identity imported');
    } catch (err) {
      append(`import failed: ${String(err)}`);
    }
  }, [importKey, append, adoptIdentity]);

  const onCopyId = useCallback(() => {
    if (!identity) return;
    void copyText(identity.pubHex).then((ok) => {
      setIdCopied(ok);
      append(ok ? 'ID copied' : 'copy unavailable — see technical details');
      if (!ok) setShowSecret(false);
    });
  }, [identity, append]);

  const onToggleIdQr = useCallback(() => setShowIdQr((v) => !v), []);

  const onRevealSecret = useCallback(() => {
    setShowSecret(true);
    setSecretCopied(false);
  }, []);

  const onHideSecret = useCallback(() => setShowSecret(false), []);

  const onCopySecret = useCallback(() => {
    if (!identity) return;
    void copyText(identity.privHex).then((ok) => {
      setSecretCopied(ok);
      append(ok ? 'secret key copied' : 'copy unavailable — select it manually');
    });
  }, [identity, append]);

  // Encrypted file backup: password-encrypted copy of the secret key for
  // moving an ID without pasting raw hex. The hex export stays as fallback.
  const onExportBackup = useCallback(async () => {
    if (!identity) return;
    if (backupPw.length < BACKUP_MIN_PASSWORD_LENGTH) {
      append(`backup password must be at least ${BACKUP_MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    setBusy(true);
    try {
      const json = await exportIdentityBackup(identity.privHex, backupPw);
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'fly-id-backup.json';
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      setBackupPw('');
      append('backup downloaded — store it away from the password');
    } catch (err) {
      append(`backup failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [identity, backupPw, append, setBusy]);

  const onRestoreBackup = useCallback(async () => {
    if (!restoreFile) {
      append('pick a backup file first');
      return;
    }
    if (!restorePw) {
      append('enter the backup password');
      return;
    }
    setBusy(true);
    try {
      const json = await restoreFile.text();
      adoptIdentity(await importIdentityBackup(json, restorePw));
      setRestorePw('');
      setRestoreFile(null);
      if (restoreFileRef.current) restoreFileRef.current.value = '';
      append('identity restored from backup');
    } catch (err) {
      append(`restore failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [restoreFile, restorePw, adoptIdentity, append, setBusy]);

  const onSaveProfile = useCallback(async () => {
    if (!service) return;
    setBusy(true);
    try {
      await authed(async (id) => {
        const sig = signProfile(id.privHex, id.pubHex, profileName, profileBio);
        const preimage = new TextEncoder().encode(`${profileName}\0${profileBio}`);
        const pow = await powFor(service, id.pubHex, preimage);
        const req = buildProfileRequest({
          author: id.pubHex,
          name: profileName,
          bio: profileBio,
          day: currentDay(),
          sig,
          pow,
        });
        const res = await fetchNym(service, {
          method: 'POST',
          ...req,
          headers: JSON_HEADERS,
        });
        append(res.error ? `profile rejected: ${res.error}` : 'profile saved');
      });
    } catch (err) {
      append(`profile failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [service, profileName, profileBio, authed, append, powFor, setBusy]);

  const onToggleIdentity = useCallback(() => setShowIdentity((v) => !v), []);

  const onCopyInvite = useCallback(() => {
    if (!service) {
      append('open a private link first');
      return;
    }
    const id = identity ?? createIdentity();
    adoptIdentity(id);
    try {
      const invite = signInvite(id.privHex, service, `Join me here`, vouchOnCopy ? trustedVouches : []);
      const link = `${service}#invite=${encodeInviteCompact(invite)}`;
      void copyText(link).then((ok) =>
        append(
          ok
            ? `invite link copied${invite.vouches ? ` (${invite.vouches.length} vouches)` : ''}`
            : `invite link (copy manually): ${link.slice(0, 80)}…`,
        ),
      );
    } catch (err) {
      append(`invite failed: ${String(err)}`);
    }
  }, [service, identity, vouchOnCopy, trustedVouches, adoptIdentity, append]);

  return {
    identity,
    authed,
    importKey,
    setImportKey,
    profileName,
    setProfileName,
    profileBio,
    setProfileBio,
    backupPw,
    setBackupPw,
    restorePw,
    setRestorePw,
    restoreFile,
    setRestoreFile,
    restoreFileRef,
    idCopied,
    showIdQr,
    showSecret,
    secretCopied,
    showIdentity,
    vouchOnCopy,
    setVouchOnCopy,
    idQrUrl,
    trustedVouches,
    onCreateIdentity,
    onNewIdentity,
    onImportIdentity,
    onCopyId,
    onToggleIdQr,
    onRevealSecret,
    onCopySecret,
    onHideSecret,
    onExportBackup,
    onRestoreBackup,
    onSaveProfile,
    onToggleIdentity,
    onCopyInvite,
  };
}
