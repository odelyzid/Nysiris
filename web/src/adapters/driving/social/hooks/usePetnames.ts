import { useCallback, useMemo, useState } from 'react';
import {
  defaultPetnameStorage,
  duplicatePetnames,
  loadPetnames,
  savePetnames,
  withPetname,
} from '../../../../application/petnameStore';

/**
 * Local petnames (names only you see) plus the inline naming editor state.
 * Duplicate labels are flagged so their display gets a hex suffix.
 */
export function usePetnames() {
  const [petnameMap, setPetnameMap] = useState<Record<string, string>>(() => loadPetnames(defaultPetnameStorage()));
  const [namingAuthor, setNamingAuthor] = useState<string | null>(null);
  const [namingValue, setNamingValue] = useState('');

  const savePetname = useCallback((author: string, name: string | null) => {
    setPetnameMap((prev) => {
      const next = withPetname(prev, author, name);
      savePetnames(next, defaultPetnameStorage());
      return next;
    });
    setNamingAuthor(null);
    setNamingValue('');
  }, []);

  /** Authors sharing one petname: their labels get a hex suffix. */
  const dupeAuthors = useMemo(() => {
    const dupes = duplicatePetnames(petnameMap);
    return new Set(Object.values(dupes).flat());
  }, [petnameMap]);

  return {
    petnameMap,
    namingAuthor,
    namingValue,
    setNamingAuthor,
    setNamingValue,
    savePetname,
    dupeAuthors,
  };
}
