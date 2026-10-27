/**
 * Memoised, one-shot mixnet tunnel bring-up.
 *
 * The Nym tunnel is one-shot per page: a second `setupMixTunnel` rejects with
 * "tunnel already initialised", and guarding on `getTunnelState()` races
 * (two call sites can both observe `connecting`). We therefore memoise a single
 * promise. `reconnectTunnel()` is the explicit exception: it tears the runtime
 * down, resets the memo, and asks the wrapper for a fresh instance while the
 * React tree (tabs/history) stays mounted. If the WASM refuses, the UI falls
 * back to a page reload.
 *
 * Security: the privacy guardrail (§5.8) fails closed if cover traffic or
 * Poisson pacing is disabled without explicit acknowledgement.
 */
import { requireCoverTraffic } from './enforcement.mjs';

export type TunnelStateName = 'connecting' | 'ready' | 'shutting_down' | 'shutdown' | 'failed';

export interface TunnelStateView {
  state: TunnelStateName;
  reason?: string;
}

/** Subset of `SetupMixTunnelOpts` we expose. See the mix-tunnel TypeDoc for all fields. */
export interface SetupTunnelOpts {
  debug?: boolean;
  /** §5.8: weakens you against a network observer. Requires acknowledgement. */
  disableCoverTraffic?: boolean;
  /** §5.8: weakens you against a network observer. Requires acknowledgement. */
  disablePoissonTraffic?: boolean;
  /** §5.4.3: pin an exit gateway (accepts the P2 linkability trade-off). */
  preferredIpr?: string;
  nymApiUrl?: string;
  forceTls?: boolean;
  /** Must be `true` to deliberately disable cover traffic / Poisson pacing. */
  privacyDowngradeAcknowledged?: boolean;
}

let tunnelPromise: Promise<unknown> | undefined;
let spent = false;
let lastOpts: SetupTunnelOpts | undefined;
let reconnectPromise: Promise<void> | null = null;

/**
 * Bring the tunnel up exactly once. Safe to call from many components; all
 * callers await the same promise. On failure the promise is cleared so a
 * retry is possible.
 */
export function ensureTunnel(opts?: SetupTunnelOpts): Promise<unknown> {
  if (opts) lastOpts = opts;
  if (spent) {
    return Promise.reject(new Error('mixnet tunnel was torn down; reconnect to create a new one'));
  }

  // §5.8 guardrail: refuse a silent privacy downgrade.
  requireCoverTraffic(
    {
      coverTraffic: !opts?.disableCoverTraffic,
      poissonPacing: !opts?.disablePoissonTraffic,
    },
    opts?.privacyDowngradeAcknowledged === true,
  );

  tunnelPromise ??= import('@nymproject/mix-fetch')
    .then((m) => m.setupMixTunnel(opts as never))
    .catch((err: unknown) => {
      tunnelPromise = undefined;
      throw err;
    });
  return tunnelPromise;
}

/** Read and normalise the tunnel state (the library may return a string or an object). */
export async function tunnelState(): Promise<TunnelStateView> {
  try {
    const mod = await import('@nymproject/mix-fetch');
    return normaliseState(await mod.getTunnelState());
  } catch (err) {
    return { state: 'failed', reason: String(err) };
  }
}

export function normaliseState(raw: unknown): TunnelStateView {
  if (typeof raw === 'string') {
    return { state: raw as TunnelStateName };
  }
  if (raw && typeof raw === 'object' && 'state' in raw) {
    const value = raw as { state: TunnelStateName; reason?: string };
    return { state: value.state, reason: value.reason };
  }
  return { state: 'failed', reason: 'unrecognised tunnel state' };
}

/** Tear the tunnel down. The WASM instance is spent afterwards. */
export async function teardownTunnel(): Promise<void> {
  const mod = await import('@nymproject/mix-fetch');
  await mod.disconnectMixTunnel();
  spent = true;
  tunnelPromise = undefined;
}

/**
 * Rebuild the tunnel without reloading the page.
 *
 * `mix-tunnel` documents the WASM as spent after `disconnectMixTunnel`; in
 * practice the wrapper recreates its worker handle on the next setup call. We
 * reset our memo, attempt the setup, and keep the app/tabs alive either way.
 * If the runtime really refuses, the caller shows the reload fallback instead
 * of silently hanging.
 */
export async function reconnectTunnel(opts?: SetupTunnelOpts): Promise<void> {
  if (reconnectPromise) return reconnectPromise;
  const nextOpts = opts ?? lastOpts;
  reconnectPromise = (async () => {
    const mod = await import('@nymproject/mix-fetch');
    try {
      await mod.disconnectMixTunnel();
    } catch {
      // An already-dead tunnel is exactly the case reconnect must recover from.
    }
    spent = false;
    tunnelPromise = undefined;
    try {
      await ensureTunnel(nextOpts);
    } catch (err) {
      spent = true;
      throw err;
    }
  })();
  try {
    await reconnectPromise;
  } finally {
    reconnectPromise = null;
  }
}

/**
 * True once the tunnel has been torn down and not yet rebuilt. The UI offers
 * `reconnectTunnel` first and only falls back to a reload if the runtime
 * cannot create a fresh instance (§5.2.2).
 */
export function tunnelSpent(): boolean {
  return spent;
}
