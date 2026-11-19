import { useCallback, useRef } from 'react';
import { MAX_POW_BITS, payloadHashBytes, provePow } from '../../../../mixnet/pow.mjs';
import { hexToBytes } from '@noble/hashes/utils.js';
import { getJson } from '../shopApi';

interface Descriptor {
  pow_bits?: unknown;
}

/**
 * Proof-of-work helper for shop writes. The required difficulty is read from
 * the provider descriptor once per address and cached; `powFor` returns
 * `null` when the service does not require a proof.
 */
export function useShopPow() {
  const bitsCache = useRef(new Map<string, number>());

  const powFor = useCallback(async (service: string, keyHex: string, payload: Uint8Array) => {
    let bits = bitsCache.current.get(service);
    if (bits === undefined) {
      // A failed descriptor fetch must not be cached as "no PoW required":
      // that silently produces writes the provider will reject. Let the
      // caller report the error and retry on the next action.
      const desc = await getJson<Descriptor>(service, '/');
      const raw = desc.pow_bits;
      if (!Number.isInteger(raw) || (raw as number) < 0 || (raw as number) > MAX_POW_BITS) {
        throw new Error(`invalid pow_bits in ${service} descriptor`);
      }
      bits = raw as number;
      bitsCache.current.set(service, bits);
    }
    if (bits === 0) return null;
    const hash = await payloadHashBytes(payload);
    const proof = await provePow(hexToBytes(keyHex), hash, bits, {});
    if (!proof) throw new Error(`could not find proof-of-work at ${bits} bits`);
    return proof;
  }, []);

  return { powFor };
}

export type ShopPowFor = ReturnType<typeof useShopPow>['powFor'];
