import { SOCIAL_TAB_META, SOCIAL_TAB_ORDER, type SocialTab } from '../../../../application/tabs';

/** Community section switcher (Timeline / Private messages / About). */
export function CommunityTabs({ tab, onSelect }: { tab: SocialTab; onSelect: (next: SocialTab) => void }) {
  return (
    <div role="tablist" aria-label="Community sections" className="fly-tabbar">
      {SOCIAL_TAB_ORDER.map((id) => (
        <button
          key={id}
          role="tab"
          aria-selected={tab === id}
          title={SOCIAL_TAB_META[id].blurb}
          onClick={() => onSelect(id)}
          className="fly-tab"
        >
          {SOCIAL_TAB_META[id].title}
        </button>
      ))}
    </div>
  );
}
