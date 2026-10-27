/**
 * Per-site permission decisions. Pages are scriptless today, so this is the
 * allow/deny surface future document features will consult; OS prompts still
 * apply to real APIs.
 */
import {
  PERMISSION_META,
  PERMISSION_NAMES,
  type PermissionDecision,
  type PermissionName,
  type PermissionRegistry,
} from '../../../application/permissions';

export function PermissionsPanel({
  scope,
  registry,
  onChange,
  onReset,
  onClose,
}: {
  scope: string;
  registry: PermissionRegistry;
  onChange: (name: PermissionName, decision: PermissionDecision) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  return (
    <section className="fly-card fly-permissions" aria-label="Site permissions">
      <div className="fly-row fly-row-between">
        <div>
          <h2 className="fly-h2-flush">Permissions</h2>
          <p className="fly-muted fly-break-all">Decisions for {scope}</p>
        </div>
        <button type="button" className="fly-btn fly-btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      <ul className="fly-plain-list fly-permission-list">
        {PERMISSION_NAMES.map((name) => {
          const decision = registry.get(scope, name);
          const meta = PERMISSION_META[name];
          return (
            <li key={name} className="fly-permission-row">
              <div>
                <strong>{meta.label}</strong>
                <span className="fly-muted">{meta.description}</span>
              </div>
              <span className="fly-row fly-permission-choices" role="group" aria-label={`${meta.label} permission`}>
                {(['ask', 'allow', 'deny'] as PermissionDecision[]).map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    className={decision === choice ? 'fly-btn fly-btn-sm fly-btn-secondary' : 'fly-btn fly-btn-sm'}
                    aria-pressed={decision === choice}
                    onClick={() => onChange(name, choice)}
                  >
                    {choice === 'ask' ? 'Ask' : choice === 'allow' ? 'Allow' : 'Block'}
                  </button>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="fly-row fly-mt-2">
        <button type="button" className="fly-btn fly-btn-sm" onClick={onReset}>
          Reset this site
        </button>
      </div>
    </section>
  );
}
