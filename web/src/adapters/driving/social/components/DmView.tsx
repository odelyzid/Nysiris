import { groupConversations, type DmRecord } from '../../../../application/conversations';
import { authorLabel } from '../../../../application/petnameStore';
import type { PreparedAttachment } from '../../../../domain/attachmentCrypto';
import { ConversationList } from './ConversationList';
import { DmComposer } from './DmComposer';
import { DmConversation } from './DmConversation';
import { EmptyState } from './EmptyState';

/** Private messages tab: composer, inbox list, open chat, empty states. */
export function DmView({
  service,
  identityPresent,
  busy,
  dms,
  dmRead,
  activeDmPeer,
  onOpenConvo,
  dmTo,
  onDmToChange,
  dmDraft,
  onDmDraftChange,
  dmFiles,
  onDmFilesChange,
  onSendDm,
  onCheckMessages,
  petnameMap,
  names,
  onError,
}: {
  service: string;
  identityPresent: boolean;
  busy: boolean;
  dms: DmRecord[];
  dmRead: Record<string, number>;
  activeDmPeer: string | null;
  onOpenConvo: (peer: string) => void;
  dmTo: string;
  onDmToChange: (value: string) => void;
  dmDraft: string;
  onDmDraftChange: (value: string) => void;
  dmFiles: PreparedAttachment[];
  onDmFilesChange: (files: PreparedAttachment[]) => void;
  onSendDm: () => void;
  onCheckMessages: () => void;
  petnameMap: Record<string, string>;
  names: Record<string, string>;
  onError: (line: string) => void;
}) {
  const convos = groupConversations(dms, dmRead);
  const totalUnread = convos.reduce((n, c) => n + c.unread, 0);
  const activeConvo = convos.find((c) => c.peer === activeDmPeer) ?? null;
  const peerLabel = (peer: string) =>
    peer === 'unknown'
      ? 'Unknown sender (legacy)'
      : authorLabel(peer, petnameMap[peer.toLowerCase()] ?? null, names[peer] ?? null);

  return (
    <div role="tabpanel" aria-label="Private messages">
      <h3 className="section-title">
        Private messages{totalUnread > 0 && <span style={{ color: '#888' }}> ({totalUnread} unread)</span>}
      </h3>
      <p className="fly-note">🔒 Messages vanish once read — even from the host.</p>
      <DmComposer
        dmTo={dmTo}
        onDmToChange={onDmToChange}
        dmDraft={dmDraft}
        onDmDraftChange={onDmDraftChange}
        dmFiles={dmFiles}
        onDmFilesChange={onDmFilesChange}
        onSend={onSendDm}
        busy={busy}
        onError={onError}
      />
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <button
          className="fly-btn fly-btn-quiet"
          onClick={onCheckMessages}
          disabled={busy || !identityPresent}
        >
          Check for new messages
        </button>
        <span style={{ fontSize: 11, color: '#888' }}>Arrivals appear automatically.</span>
      </div>
      {convos.length > 0 && (
        <ConversationList convos={convos} activeDmPeer={activeDmPeer} onOpen={onOpenConvo} peerLabel={peerLabel} />
      )}
      {activeConvo ? (
        <DmConversation activeConvo={activeConvo} peerLabel={peerLabel} service={service} />
      ) : (
        <EmptyState glyph="✉️" title={convos.length === 0 ? 'No messages yet' : 'No conversation open'}>
          <p>
            {convos.length === 0
              ? 'When someone writes to your ID, it appears here automatically.'
              : 'Pick a conversation above to read and reply.'}
          </p>
        </EmptyState>
      )}
    </div>
  );
}
