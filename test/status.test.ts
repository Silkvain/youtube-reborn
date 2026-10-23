import { statusLine, type StatusInput } from '../src/background/status';
import { PURPOSE_BUDGETS } from '../src/shared/constants';

const base: StatusInput = {
  enabled: true,
  loggedOut: false,
  stoppedForToday: false,
  subscriptions: 400,
  covered: 150,
  feedSynced: true,
  feedFailing: false,
  spent: { subs: 4, top: 6, discovery: 20, mentions: 2 },
  budgets: PURPOSE_BUDGETS,
  tabActive: true,
};

describe('popup status line', () => {
  it('explains coverage and limits in words instead of a bare count', () => {
    expect(statusLine(base)).toBe('Discovery covers your top 150 of 400 channels so far.');
    expect(statusLine({ ...base, spent: { ...base.spent, discovery: PURPOSE_BUDGETS.discovery } })).toMatch(
      /top 150 of 400 channels so far; paused until tomorrow to stay gentle with YouTube/,
    );
    expect(statusLine({ ...base, tabActive: false })).toMatch(/continues while a YouTube tab is open/);
    expect(statusLine({ ...base, covered: 400 })).toBe('Up to date. Discovery covers all 400 of your channels.');
  });

  it('puts blocking states first', () => {
    expect(statusLine({ ...base, enabled: false })).toMatch(/^Off/);
    expect(statusLine({ ...base, loggedOut: true })).toMatch(/Sign in/);
    expect(statusLine({ ...base, stoppedForToday: true })).toMatch(/Paused until tomorrow/);
    expect(statusLine({ ...base, feedFailing: true })).toMatch(/subscriptions feed/);
    expect(statusLine({ ...base, feedSynced: false })).toMatch(/Open YouTube’s Home page/);
  });
});
