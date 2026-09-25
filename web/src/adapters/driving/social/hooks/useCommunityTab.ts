import { useCallback, useState } from 'react';
import {
  defaultSocialTabStorage,
  loadSocialTab,
  saveSocialTab,
  type SocialTab,
} from '../../../../application/tabs';

/** Active community tab (Timeline / Private messages / About), persisted. */
export function useCommunityTab() {
  const [tab, setTab] = useState<SocialTab>(() => loadSocialTab(defaultSocialTabStorage()));

  const onSelectTab = useCallback((next: SocialTab) => {
    setTab(next);
    saveSocialTab(next, defaultSocialTabStorage());
  }, []);

  return { tab, onSelectTab };
}
