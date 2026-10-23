/**
 * The "Enhanced discoverability" backend address is fixed at build time:
 *   COMMUNITY_API=https://community.example.com npm run build
 * Without it the feature does not exist in that build: no toggle, no permission, no requests.
 */
declare const __COMMUNITY_API__: string | undefined;
declare const __COMMUNITY_TEST__: boolean | undefined;

export const COMMUNITY_API: string = (typeof __COMMUNITY_API__ === 'string' ? __COMMUNITY_API__ : '').replace(/\/+$/, '');

export function communityAvailable(): boolean {
  return COMMUNITY_API !== '';
}

/** The host permission requested when the user switches the feature on (and only then). */
export function communityPermission(): string | null {
  return COMMUNITY_API ? `${new URL(COMMUNITY_API).origin}/*` : null;
}

/**
 * Test builds only (COMMUNITY_TEST=1): uploads happen minutes apart instead of hours, so the
 * whole path can be checked by hand. Never publish a build made with it.
 */
export const COMMUNITY_TEST: boolean = typeof __COMMUNITY_TEST__ === 'boolean' && __COMMUNITY_TEST__;
