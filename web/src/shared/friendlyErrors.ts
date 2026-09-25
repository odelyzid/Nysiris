/**
 * Human-readable error mapping for the main UI.
 *
 * Raw SDK/tunnel errors are technical and often alarming
 * ("tunnel already initialised", "SURB reply timed out"). The main view
 * shows `title` + `help` + a recovery action; the raw text stays behind
 * "Technical details" / "Copy error". Pure logic, tested with
 * `node --test web/test`.
 */

export interface FriendlyError {
  /** Short calm headline, e.g. "Something went wrong". */
  title: string;
  /** One friendly sentence saying what happened and what to do. */
  help: string;
  /** Label for the primary recovery button. */
  action: string;
  /** The raw technical text, for details / copy. */
  technical: string;
}

const PATTERNS: { match: RegExp; title: string; help: string; action: string }[] = [
  {
    match: /torn down|reload the page/i,
    title: 'Private session ended',
    help: 'You switched the private network off. Reload the page to start a fresh private session.',
    action: 'Reload',
  },
  {
    match: /already initiali[sz]ed|one-shot|ensureTunnel/i,
    title: 'Already connecting',
    help: 'Your private connection is already starting. Give it a moment — there is nothing else to do.',
    action: 'Try again',
  },
  {
    match: /timed out|timeout|deadline/i,
    title: 'Taking longer than usual',
    help: 'The private network is slow right now. Check your connection and try again.',
    action: 'Try again',
  },
  {
    match: /surb|reply budget|slow down/i,
    title: 'Reply could not be sent',
    help: 'That reply used up its one-time private ticket. Ask the other person to write again, then reply once.',
    action: 'Try again',
  },
  {
    match: /invite|signature invalid|not saved/i,
    title: 'Invite could not be saved',
    help: 'That invite does not look genuine, so we did not save it. Ask the sender for a fresh invite link.',
    action: 'Try again',
  },
  {
    match: /cover traffic|poisson|privacy downgrade/i,
    title: 'Extra privacy is on',
    help: 'This setting would make you easier to observe, so we kept the safer option on.',
    action: 'Keep me protected',
  },
  {
    match: /offline|network|fetch|connection|gateway|topology|wss|websocket/i,
    title: 'Something went wrong',
    help: 'We could not reach the private network. Check your internet connection and try again.',
    action: 'Try again',
  },
];

/** Map any thrown value to a calm, actionable message. Never throws. */
export function friendlyError(err: unknown): FriendlyError {
  const technical = err instanceof Error ? err.message || String(err) : String(err ?? 'unknown error');
  const text = technical.trim() || 'unknown error';
  for (const p of PATTERNS) {
    if (p.match.test(text)) {
      return { title: p.title, help: p.help, action: p.action, technical: text };
    }
  }
  return {
    title: 'Something went wrong',
    help: 'That did not work. Check your connection and try again.',
    action: 'Try again',
    technical: text,
  };
}

/** One-line status headlines for the nav pill popover. */
export function statusHeadline(state: string): { title: string; help: string } {
  switch (state) {
    case 'ready':
      return {
        title: 'You are protected',
        help: 'Your traffic is travelling the private network. You can browse and chat.',
      };
    case 'connecting':
      return {
        title: 'Connecting…',
        help: 'Finding the fastest private path. This usually takes a few seconds.',
      };
    case 'shutting_down':
      return {
        title: 'Switching off…',
        help: 'Closing your private connection. Reload the page to start a new one.',
      };
    case 'shutdown':
      return {
        title: 'Not protected',
        help: 'Connect privately to browse and chat over the private network.',
      };
    case 'failed':
      return {
        title: 'Something went wrong',
        help: 'We could not reach the private network. Check your connection and try again.',
      };
    default:
      return {
        title: 'Checking status…',
        help: 'Working out whether you are protected.',
      };
  }
}
