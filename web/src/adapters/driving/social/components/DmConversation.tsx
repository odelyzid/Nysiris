import { AttachmentList } from '../attachmentUi';
import type { Conversation } from '../../../../application/conversations';

/** Open 1:1 conversation transcript (messages oldest first). */
export function DmConversation({
  activeConvo,
  peerLabel,
  service,
}: {
  activeConvo: Conversation;
  peerLabel: (peer: string) => string;
  service: string;
}) {
  return (
    <>
      <h3 style={{ fontSize: 15 }}>Chat with {peerLabel(activeConvo.peer)}</h3>
      <ul style={{ fontSize: 13, listStyle: 'none', padding: 0 }}>
        {activeConvo.messages.map((m) => (
          <li key={m.msgId} style={{ borderTop: '1px solid #eee', padding: '6px 0' }}>
            {m.incoming ? (
              <span title="Only you can read this — it was deleted from the community when you picked it up">🔒</span>
            ) : (
              <span title="Sent by you">✓ </span>
            )}{' '}
            <span style={{ wordBreak: 'break-word' }}>{m.text}</span>{' '}
            <span style={{ color: '#888', fontSize: 11 }}>{new Date(m.ts).toLocaleTimeString()}</span>
            {m.attachments && m.attachments.length > 0 && (
              <AttachmentList service={service} refs={m.attachments} />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
