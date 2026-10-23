import { dominantScript, latinLanguage, namedLanguage, readable, userLanguages } from '../src/core/language';

// Titles from YouTube's "today, by views" and News hub results (2026-10-16/17).
const gb = { languages: userLanguages('en-GB', 'GB', []), mode: 'full' as const };
const nl = { languages: userLanguages('nl-NL', 'NL', []), mode: 'full' as const };

describe('language check for top-row candidates', () => {
  it('keeps English titles for an English-speaking user', () => {
    for (const t of [
      "Roadster | The Last Best Driver's Car",
      'Trailer 2 : Ramayana: Rise of a Legend | In Cinemas',
      'BREAKING: WH Press Secretary Katie Zacharia resigns after one week',
      "Porsche just proved why it's the SUPERCAR king",
      'Yorkshire Wildlife Park reopens after deadly tiger attack',
    ]) {
      expect(readable(t, gb)).toBe(true);
    }
  });

  it('drops titles in a script the user does not read', () => {
    expect(readable('صلاة الجمعة من المسجد الحرام بث مباشر', gb)).toBe(false);
    expect(readable('आज की ताज़ा खबरें और मुख्य समाचार', gb)).toBe(false);
    expect(readable('Новости дня: главные события', gb)).toBe(false);
    expect(readable('صلاة الجمعة من المسجد الحرام بث مباشر', { languages: new Set(['en', 'ar']), mode: 'full' })).toBe(true);
  });

  it('drops titles that name another language', () => {
    expect(namedLanguage('Raja The Great (2026) New Released Hindi Dubbed Movie')).toBe('hi');
    expect(readable('Raja The Great (2026) New Released Hindi Dubbed Movie', gb)).toBe(false);
  });

  it('tells Dutch from English in full mode, and lets the news (script mode) through', () => {
    const dutch = 'Een week vol ruzie tussen Zelensky en Trump';
    expect(latinLanguage(dutch)).toBe('nl');
    expect(readable(dutch, gb)).toBe(false);
    expect(readable(dutch, nl)).toBe(true);
    expect(readable(dutch, { ...gb, mode: 'script' })).toBe(true);
  });

  it('accepts anything it is unsure about', () => {
    expect(latinLanguage('MrBeast')).toBeUndefined();
    expect(readable('GTA VI', gb)).toBe(true);
    expect(dominantScript('🔥🔥')).toBeNull();
  });

  it('learns extra languages from what the user subscribes to', () => {
    const titles = Array.from({ length: 10 }, (_, i) => (i < 4 ? `Het nieuws van de dag over de stad ${i}` : `How to fix the car in ${i} steps`));
    const langs = userLanguages('en-GB', 'GB', titles);
    expect(langs.has('nl')).toBe(true);
    expect(langs.has('en')).toBe(true);
  });

  it('knows a region\'s languages even when the UI is English', () => {
    expect([...userLanguages('en', 'NL', [])].sort()).toEqual(['en', 'nl']);
  });
});
