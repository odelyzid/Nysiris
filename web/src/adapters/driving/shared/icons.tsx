/** Small inline icons shared by the social/DM UI (no emoji, no icon font). */

type IconProps = { size?: number; className?: string };

function base(props: IconProps) {
  const { size = 16, className } = props;
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
    focusable: false,
  };
}

/** Padlock used for "only the recipient can read this". */
export function LockIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="1.5" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
      <path d="M12 14.5v2.5" />
    </svg>
  );
}

/** Closed envelope for an empty DM list. */
export function EnvelopeIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="5.5" width="18" height="13" rx="1.5" />
      <path d="M3.5 6.5 12 13l8.5-6.5" />
    </svg>
  );
}

/** Speech bubble for an empty timeline. */
export function ChatIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M20 15.5a2 2 0 0 1-2 2H8l-4 3v-15a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
      <path d="M8 9.5h8M8 13h5" />
    </svg>
  );
}

/** Delivery check for an outgoing message. */
export function CheckIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4.5 12.5 9.5 17.5 19.5 7" />
    </svg>
  );
}

/** Dismiss/remove action. */
export function CloseIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

/** Favourite star (filled when active is handled by the caller). */
export function StarIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z" />
    </svg>
  );
}

/** Refresh/reload action. */
export function RefreshIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v5h-5" />
    </svg>
  );
}

/** Bookmark action. */
export function BookmarkIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 4h12v17l-6-4-6 4z" />
    </svg>
  );
}
