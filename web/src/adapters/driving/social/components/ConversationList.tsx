import type { Conversation } from '../../../../application/conversations';

/** Inbox list: one row per peer, newest conversation first. */
export function ConversationList({
  convos,
  activeDmPeer,
  onOpen,
  peerLabel,
}: {
  convos: Conversation[];
  activeDmPeer: string | null;
  onOpen: (peer: string) => void;
  peerLabel: (peer: string) => string;
}) {
  return (
    <>
      <h3 className="section-title">Conversations</h3>
      <ul className="fly-conv-list">
        {convos.map((c) => {
          const last = c.messages[c.messages.length - 1];
          return (
            <li key={c.peer}>
              <button aria-current={activeDmPeer === c.peer} onClick={() => onOpen(c.peer)}>
                <strong>{peerLabel(c.peer)}</strong>
                {c.unread > 0 && <span> ({c.unread} new)</span>}{' '}
                <span className="fly-muted">{last ? last.text.slice(0, 60) : ''}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
