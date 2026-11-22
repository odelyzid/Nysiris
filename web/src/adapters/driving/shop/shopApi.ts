/**
 * Thin typed JSON client over `fetchNym` for the shop provider. Every call is
 * one request/one SURB reply; `fetchNym` already serializes them.
 */
import { fetchNym, fetchNymParallel } from '../../../mixnet/fetchNym';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function errorText(status: number, body: Uint8Array): string {
  const text = new TextDecoder().decode(body).trim();
  if (!text) return `HTTP ${status}`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error;
  } catch {
    // Plain-text error body from a provider that predates JSON errors.
  }
  // Never pass an unlabelled JSON blob off as the provider's error message.
  const clipped = text.slice(0, 300);
  return `${clipped}${text.length > clipped.length ? '…' : ''}`;
}

function decode<T>(status: number, body: Uint8Array, transportError: string | null, route: string): T {
  if (transportError) throw new Error(transportError);
  if (status < 200 || status >= 300) {
    throw new Error(`${route}: ${errorText(status, body)}`);
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    throw new Error(`${route}: response was not JSON`);
  }
}

export async function getJson<T>(service: string, path: string): Promise<T> {
  if (!service) throw new Error('no shop service selected');
  const res = await fetchNym(service, { method: 'GET', path });
  return decode<T>(res.status, res.body, res.error, path);
}

/**
 * Several independent reads in one burst, matched by echoed correlation tags.
 * A shop provider built on `nym_hidden_service::dispatch` echoes tags; older
 * ones transparently fall back to serial requests inside `fetchNymParallel`.
 * Results follow the order of `paths`.
 */
export async function getJsonParallel<T>(service: string, paths: string[]): Promise<T[]> {
  if (!service) throw new Error('no shop service selected');
  if (paths.length === 0) return [];
  const responses = await fetchNymParallel(
    service,
    paths.map((path) => ({ method: 'GET', path })),
  );
  return responses.map((res, i) =>
    decode<T>(res.status, res.body, res.error, paths[i]),
  );
}

export async function postJson<T>(service: string, path: string, payload: unknown): Promise<T> {
  if (!service) throw new Error('no shop service selected');
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const res = await fetchNym(service, { method: 'POST', path, headers: JSON_HEADERS, body });
  return decode<T>(res.status, res.body, res.error, path);
}
