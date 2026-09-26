import type { TunnelStateView } from './tunnel';

export interface StatusView {
  label: string;
  tone: string;
}

/** Human-readable status for the UI. Tones are theme tokens, not raw hex. */
export function describeStatus(state: TunnelStateView): StatusView {
  switch (state.state) {
    case 'ready':
      return { label: 'Connected — mixnet tunnel ready', tone: 'var(--fly-good)' };
    case 'connecting':
      return { label: 'Connecting — fetching topology and selecting a gateway…', tone: 'var(--fly-warn)' };
    case 'shutting_down':
      return { label: 'Shutting down…', tone: 'var(--fly-warn)' };
    case 'shutdown':
      return { label: 'Disconnected', tone: 'var(--fly-muted)' };
    case 'failed':
      return {
        label: `Failed${state.reason ? `: ${state.reason}` : ''}`,
        tone: 'var(--fly-bad)',
      };
    default:
      return { label: 'Unknown', tone: 'var(--fly-muted)' };
  }
}
