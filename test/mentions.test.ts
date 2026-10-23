import { extractMentions, refToUrl } from '../src/core/mentions';

describe('extractMentions', () => {
  it('finds channel links, handle links and legacy URLs', () => {
    const m = extractMentions(
      [
        'Thanks to https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA for the help',
        'Watch https://youtube.com/@SmarterEveryDay. and www.youtube.com/c/Vsauce',
        'Old link: youtube.com/user/minutephysics',
      ].join('\n'),
    );
    expect([...m.channelIds]).toEqual(['UCHnyfMqiRRG1u-2MsSQLbXA']);
    expect([...m.refs].sort()).toEqual(['/c/vsauce', '/user/minutephysics', '@smartereveryday']);
  });

  it('finds bare @handles but not emails or other platforms', () => {
    const m = extractMentions(
      [
        'Collab with @3blue1brown and (@numberphile)!',
        'Business: hello@example.com',
        'Twitter: @someone_on_x',
        'Instagram @insta_person',
        'Read medium.com/@author for more',
        '@ab is too short',
      ].join('\n'),
    );
    expect([...m.refs].sort()).toEqual(['@3blue1brown', '@numberphile']);
  });

  it('normalises case and trailing punctuation', () => {
    const m = extractMentions('Go see @Kurzgesagt. Also @Kurzgesagt!');
    expect([...m.refs]).toEqual(['@kurzgesagt']);
  });

  it('handles empty descriptions', () => {
    const m = extractMentions('');
    expect(m.refs.size + m.channelIds.size).toBe(0);
  });

  it('builds resolve URLs', () => {
    expect(refToUrl('@veritasium')).toBe('https://www.youtube.com/@veritasium');
    expect(refToUrl('/c/vsauce')).toBe('https://www.youtube.com/c/vsauce');
  });
});
