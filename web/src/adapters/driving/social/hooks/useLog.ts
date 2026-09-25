import { useCallback, useState } from 'react';

/** Rolling technical log (last 20 lines) shown in About → Technical log. */
export function useLog() {
  const [log, setLog] = useState<string[]>([]);
  const append = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-19), `${new Date().toLocaleTimeString()}  ${line}`]);
  }, []);
  return { log, append };
}
