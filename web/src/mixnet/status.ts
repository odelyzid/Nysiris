import type { TunnelStateView } from './tunnel';

export interface StatusView {
  label: string;
  tone: string;
}

/** Human-readable status for the UI. */
export function describeStatus(state: TunnelStateView): StatusView {
  switch (state.state) {
    case 'ready':
      return { label: 'Connected — mixnet tunnel ready', tone: '#0a7a4a' };
    case 'connecting':
      return { label: 'Connecting — fetching topology and selecting a gateway…', tone: '#b26b00' };
    case 'shutting_down':
      return { label: 'Shutting down…', tone: '#b26b00' };
    case 'shutdown':
      return { label: 'Disconnected', tone: '#555' };
    case 'failed':
      return {
        label: `Failed${state.reason ? `: ${state.reason}` : ''}`,
        tone: '#b00020',
      };
    default:
      return { label: 'Unknown', tone: '#555' };
  }
}
