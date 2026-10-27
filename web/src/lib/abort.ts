/**
 * Abort helper shared by the mixnet transports and the browser shell.
 *
 * The browser SDKs do not expose a portable way to cancel a tunnel request, so
 * callers race the transport promise with the navigation signal. Owned
 * transports (the Nym envelope client) additionally drop their waiter, which
 * means a late SURB reply is discarded instead of resolving a stopped load.
 */

/** DOMException-compatible AbortError without relying on DOMException in tests. */
export function abortError(message = 'The operation was aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Resolve with `promise`, or reject as soon as `signal` aborts. */
export function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(resolve, value),
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
