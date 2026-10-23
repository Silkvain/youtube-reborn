/**
 * The window shown once, on install (backend-enabled builds only): asks whether to switch on
 * Enhanced discoverability. Nothing is shared unless the user clicks Agree and the browser grants
 * the server permission. Closing the window without choosing leaves it off.
 */
import { communityPermission } from '../shared/community/config';
import { setEnhancedDiscovery } from '../shared/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const agree = $<HTMLButtonElement>('agree');
const deny = $<HTMLButtonElement>('deny');

/** Recorded so the window is never shown again (the popup switch is the place to change it). */
async function recordAnswer(answer: 'agreed' | 'denied'): Promise<void> {
  await chrome.storage.local.set({ welcomeAnswer: answer, welcomeAnsweredAt: Date.now() });
}

function finish(title: string, text: string): void {
  $('ask').hidden = true;
  $('done').hidden = false;
  $('doneTitle').textContent = title;
  $('doneText').textContent = text;
  setTimeout(() => window.close(), 4000);
}

agree.addEventListener('click', async () => {
  const permission = communityPermission();
  if (!permission) return;
  agree.disabled = deny.disabled = true;
  // Must run directly in the click handler: the browser only shows its prompt for a user gesture.
  const granted = await chrome.permissions.request({ origins: [permission] }).catch(() => false);
  if (!granted) {
    agree.disabled = deny.disabled = false;
    $('error').hidden = false;
    return;
  }
  await setEnhancedDiscovery(true);
  await recordAnswer('agreed');
  finish('Enhanced discoverability is on', 'Thanks for helping everyone discover better videos. You can switch it off any time in the toolbar popup.');
});

deny.addEventListener('click', async () => {
  agree.disabled = deny.disabled = true;
  await setEnhancedDiscovery(false);
  await recordAnswer('denied');
  finish('Enhanced discoverability is off', 'Nothing will be shared. You can switch it on any time in the toolbar popup.');
});
