import { useState } from 'react';

/** Shared in-flight flag for send/profile/backup actions. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  return { busy, setBusy };
}
