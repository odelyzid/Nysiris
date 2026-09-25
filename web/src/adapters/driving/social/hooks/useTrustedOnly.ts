import { useCallback, useState } from 'react';
import { defaultBooleanStorage, loadTrustedOnly, saveTrustedOnly } from '../../../../application/settings';

/** Timeline scope toggle: everyone, or only authors shown as trusted. */
export function useTrustedOnly() {
  const [trustedOnly, setTrustedOnly] = useState<boolean>(() => loadTrustedOnly(defaultBooleanStorage()));

  const toggleTrustedOnly = useCallback(() => {
    setTrustedOnly((prev) => {
      const next = !prev;
      saveTrustedOnly(next, defaultBooleanStorage());
      return next;
    });
  }, []);

  return { trustedOnly, toggleTrustedOnly };
}
