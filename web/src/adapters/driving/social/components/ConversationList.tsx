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
          const active = activeDmPeer === c.peer;
          return (
            <li key={c.peer}>
              <button
                aria-current={active ? 'true' : undefined}
                onClick={() => onOpen(c.peer)}
                title={last ? last.text : undefined}
              >
                <span className="fly-conv-name">
                  <strong>{peerLabel(c.peer)}</strong>
                  {c.unread > 0 && (
                    <span className="fly-badge" aria-label={`${c.unread} unread`}>
                      {c.unread}
                    </span>
                  )}
                </span>
                <span className="fly-conv-preview">
                  {last ? last.text.slice(0, 80) : 'No messages yet'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
