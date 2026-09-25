import { AttachmentPicker, type PreparedAttachment } from '../attachmentUi';
import { QrScanButton } from '../../shared/QrScanButton';

/** DM composer: recipient (with QR scan), message body, attachments, Send. */
export function DmComposer({
  dmTo,
  onDmToChange,
  dmDraft,
  onDmDraftChange,
  dmFiles,
  onDmFilesChange,
  onSend,
  busy,
  onError,
}: {
  dmTo: string;
  onDmToChange: (value: string) => void;
  dmDraft: string;
  onDmDraftChange: (value: string) => void;
  dmFiles: PreparedAttachment[];
  onDmFilesChange: (files: PreparedAttachment[]) => void;
  onSend: () => void;
  busy: boolean;
  onError: (line: string) => void;
}) {
  return (
    <div className="fly-dm-composer">
      <label className="fly-dm-to">
        To:
        <input
          className="fly-input"
          placeholder="Their 64-hex ID"
          value={dmTo}
          onChange={(e) => onDmToChange(e.target.value)}
          spellCheck={false}
          aria-label="Recipient ID"
        />
        <QrScanButton
          label="Scan ID"
          onScanText={(text) => {
            const id = text.trim().toLowerCase();
            if (/^[0-9a-f]{64}$/.test(id)) onDmToChange(id);
            else onError('that QR code is not an ID (64 hex characters)');
          }}
          onScanError={(message) => onError(`qr scan: ${message}`)}
        />
      </label>
      <textarea
        className="fly-input fly-dm-message"
        rows={2}
        placeholder="Secret message"
        value={dmDraft}
        aria-label="Secret message"
        onChange={(e) => onDmDraftChange(e.target.value)}
        onInput={(e) => {
          const el = e.currentTarget;
          el.style.height = 'auto';
          el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
        }}
      />
      <div className="fly-dm-actions">
        <AttachmentPicker
          files={dmFiles}
          onChange={onDmFilesChange}
          onError={onError}
          disabled={busy}
          inputId="fly-attach-dm"
        />
        <button className="fly-btn fly-btn-primary" onClick={onSend} disabled={busy || !dmTo || !dmDraft}>
          Send
        </button>
      </div>
    </div>
  );
}
