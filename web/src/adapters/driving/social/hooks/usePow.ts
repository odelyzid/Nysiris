import { useCallback, useRef } from 'react';
import { fetchNym } from '../../../../mixnet/fetchNym';
import { payloadHashBytes, provePow } from '../../../../mixnet/pow.mjs';
import { hexToBytes } from '@noble/hashes/utils.js';

/**
 * Proof-of-work helper. Reads the service's required difficulty from its
 * descriptor once per address (cached) and proves work when needed.
 */
export function usePow() {
  const powBitsCache = useRef(new Map<string, number>());

  /** Prove work if the service requires it; null when not required. */
  const powFor = useCallback(async (serviceAddr: string, keyHex: string, payload: Uint8Array) => {
    let bits = powBitsCache.current.get(serviceAddr);
    if (bits === undefined) {
      try {
        const res = await fetchNym(serviceAddr, { method: 'GET', path: '/' });
        const desc = JSON.parse(new TextDecoder().decode(res.body)) as { pow_bits?: unknown };
        bits = typeof desc.pow_bits === 'number' ? desc.pow_bits : 0;
      } catch {
        bits = 0;
      }
      powBitsCache.current.set(serviceAddr, bits);
    }
    if (!bits) return null;
    const hash = await payloadHashBytes(payload);
    return provePow(hexToBytes(keyHex), hash, bits, {});
  }, []);

  return { powFor };
}

export type PowFor = ReturnType<typeof usePow>['powFor'];
