/**
 * Runs at document_start, before YouTube paints. When enabled, adds the class that hides the
 * native home grid (see boot.css) so it never flashes. Toggling updates the class live.
 */
import { getSettings, onEnabledChange } from '../shared/settings';
import { ENABLED_CLASS } from './selectors';

function apply(enabled: boolean): void {
  document.documentElement.classList.toggle(ENABLED_CLASS, enabled);
}

// Assume enabled until storage answers: storage is fast, and hiding briefly is better than a flash.
// The default is `enabled: true`, so this matches the common case.
apply(true);
getSettings()
  .then((s) => apply(s.enabled))
  .catch(() => apply(false));
onEnabledChange(apply);
