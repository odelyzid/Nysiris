import { useRef, type KeyboardEvent } from 'react';
import { SOCIAL_TAB_META, SOCIAL_TAB_ORDER, type SocialTab } from '../../../../application/tabs';

/** Community section switcher (Timeline / Private messages / About). */
export function CommunityTabs({ tab, onSelect }: { tab: SocialTab; onSelect: (next: SocialTab) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = SOCIAL_TAB_ORDER.length - 1;
    let next = index;
    if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else return;
    event.preventDefault();
    onSelect(SOCIAL_TAB_ORDER[next]);
    refs.current[next]?.focus();
  };

  return (
    <div role="tablist" aria-label="Community sections" className="fly-tabbar">
      {SOCIAL_TAB_ORDER.map((id, index) => (
        <button
          key={id}
          ref={(el) => {
            refs.current[index] = el;
          }}
          id={`social-tab-${id}`}
          role="tab"
          aria-selected={tab === id}
          aria-controls={`social-panel-${id}`}
          tabIndex={tab === id ? 0 : -1}
          title={SOCIAL_TAB_META[id].blurb}
          onClick={() => onSelect(id)}
          onKeyDown={(event) => onKeyDown(event, index)}
          className="fly-tab"
        >
          {SOCIAL_TAB_META[id].title}
        </button>
      ))}
    </div>
  );
}
