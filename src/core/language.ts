/**
 * Rough language checks for top-row candidates, from titles alone. Deliberately neutral: it only
 * asks "is this in a language the user reads?", never anything about who the user is.
 *
 * - Script: a title written mostly in a script none of the user's languages use (Arabic,
 *   Devanagari, Cyrillic, …) is a mismatch. Reliable.
 * - Latin-script languages: a small stop-word count tells English from Dutch, Spanish, etc.
 *   Only a clear result counts; anything unsure is accepted.
 * - Named languages: "… Hindi Dubbed", "Tamil Full Movie" name the language of the video.
 */

export type Script =
  | 'latin' | 'cyrillic' | 'greek' | 'arabic' | 'hebrew' | 'devanagari' | 'bengali' | 'gurmukhi'
  | 'gujarati' | 'tamil' | 'telugu' | 'kannada' | 'malayalam' | 'thai' | 'hangul' | 'kana' | 'han';

const SCRIPT_RANGES: [Script, RegExp][] = [
  ['latin', /[A-Za-zÀ-ɏ]/],
  ['cyrillic', /[Ѐ-ӿ]/],
  ['greek', /[Ͱ-Ͽ]/],
  ['arabic', /[؀-ۿݐ-ݿ]/],
  ['hebrew', /[֐-׿]/],
  ['devanagari', /[ऀ-ॿ]/],
  ['bengali', /[ঀ-৿]/],
  ['gurmukhi', /[਀-੿]/],
  ['gujarati', /[઀-૿]/],
  ['tamil', /[஀-௿]/],
  ['telugu', /[ఀ-౿]/],
  ['kannada', /[ಀ-೿]/],
  ['malayalam', /[ഀ-ൿ]/],
  ['thai', /[฀-๿]/],
  ['hangul', /[가-힯ᄀ-ᇿ]/],
  ['kana', /[぀-ヿ]/],
  ['han', /[一-鿿]/],
];

/** The script most of a title's letters are in, or null when it has too few letters to tell. */
export function dominantScript(text: string): Script | null {
  const counts = new Map<Script, number>();
  let letters = 0;
  for (const ch of text) {
    for (const [script, re] of SCRIPT_RANGES) {
      if (re.test(ch)) {
        counts.set(script, (counts.get(script) ?? 0) + 1);
        letters++;
        break;
      }
    }
  }
  if (letters < 4) return null;
  // Japanese titles mix kana and kanji: any kana makes it Japanese.
  if ((counts.get('kana') ?? 0) >= 2) return 'kana';
  let best: Script | null = null;
  let bestN = 0;
  for (const [s, n] of counts) if (n > bestN) [best, bestN] = [s, n];
  return best && bestN / letters >= 0.4 ? best : null;
}

/** Scripts each language is written in. Unlisted languages count as Latin. */
const LANGUAGE_SCRIPTS: Record<string, Script[]> = {
  ru: ['cyrillic'], uk: ['cyrillic'], bg: ['cyrillic'], sr: ['cyrillic', 'latin'], mk: ['cyrillic'], be: ['cyrillic'], kk: ['cyrillic'],
  el: ['greek'],
  ar: ['arabic'], fa: ['arabic'], ur: ['arabic'],
  he: ['hebrew'],
  hi: ['devanagari'], mr: ['devanagari'], ne: ['devanagari'],
  bn: ['bengali'], pa: ['gurmukhi'], gu: ['gujarati'], ta: ['tamil'], te: ['telugu'], kn: ['kannada'], ml: ['malayalam'],
  th: ['thai'], ko: ['hangul'], ja: ['kana', 'han'], zh: ['han'],
};

export function scriptsOf(lang: string): Script[] {
  return LANGUAGE_SCRIPTS[lang] ?? ['latin'];
}

/** Main languages per YouTube region (two letters); the user's UI language is added on top. */
const REGION_LANGUAGES: Record<string, string[]> = {
  GB: ['en'], US: ['en'], IE: ['en'], AU: ['en'], NZ: ['en'], CA: ['en', 'fr'],
  NL: ['nl'], BE: ['nl', 'fr'], DE: ['de'], AT: ['de'], CH: ['de', 'fr', 'it'], FR: ['fr'], LU: ['fr', 'de'],
  ES: ['es'], MX: ['es'], AR: ['es'], CO: ['es'], CL: ['es'], PE: ['es'], PT: ['pt'], BR: ['pt'], IT: ['it'],
  PL: ['pl'], CZ: ['cs'], SK: ['sk'], HU: ['hu'], RO: ['ro'], SE: ['sv'], NO: ['no'], DK: ['da'], FI: ['fi'],
  TR: ['tr'], GR: ['el'], RU: ['ru'], UA: ['uk'], IL: ['he'], SA: ['ar'], AE: ['ar', 'en'], EG: ['ar'],
  IN: ['en', 'hi'], PK: ['ur', 'en'], BD: ['bn'], ID: ['id'], MY: ['ms', 'en'], PH: ['en'], SG: ['en'],
  TH: ['th'], VN: ['vi'], JP: ['ja'], KR: ['ko'], TW: ['zh'], HK: ['zh', 'en'], CN: ['zh'], ZA: ['en'], NG: ['en'],
};

export function regionLanguages(region: string | undefined): string[] {
  return (region && REGION_LANGUAGES[region.toUpperCase()]) || [];
}

/** "en-GB" -> "en". */
export function baseLanguage(hl: string | undefined): string | undefined {
  const m = hl?.toLowerCase().match(/^[a-z]{2,3}/);
  return m?.[0];
}

/**
 * Common short words per Latin-script language; a clear majority of hits names the language.
 * One-letter words are left out: "i", "a", "o", "y" mean something in too many languages.
 */
const STOP_WORDS: Record<string, string[]> = {
  en: ['the', 'and', 'of', 'to', 'in', 'is', 'you', 'for', 'with', 'this', 'on', 'my', 'how', 'what', 'are', 'it', 'from', 'your', 'was', 'at', 'after', 'why', 'new', 'just', 'if', 'no', 'one', 'has', 'have', 'here', 'we', 'me', 'all', 'can', 'got', 'get', 'he', 'she', 'they', 'his', 'her', 'an', 'be', 'so', 'out', 'up', 'vs'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'niet', 'op', 'met', 'voor', 'dat', 'zijn', 'wat', 'naar', 'ook', 'nieuws', 'over', 'na', 'bij', 'wordt', 'hoe', 'deze'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'ein', 'eine', 'für', 'auf', 'den', 'dem', 'wie', 'was', 'ich', 'nach', 'über', 'bei', 'wird', 'sich'],
  fr: ['le', 'la', 'les', 'et', 'est', 'un', 'une', 'des', 'du', 'pour', 'dans', 'pas', 'avec', 'sur', 'qui', 'ce', 'au', 'je', 'mon', 'comment', 'après'],
  es: ['el', 'la', 'los', 'las', 'y', 'es', 'un', 'una', 'del', 'para', 'con', 'por', 'que', 'en', 'mi', 'cómo', 'qué', 'muy', 'pero', 'más'],
  pt: ['o', 'a', 'os', 'as', 'e', 'é', 'um', 'uma', 'do', 'da', 'para', 'com', 'que', 'não', 'no', 'na', 'meu', 'como', 'mais', 'você'],
  it: ['il', 'lo', 'la', 'gli', 'le', 'e', 'è', 'un', 'una', 'di', 'per', 'con', 'che', 'non', 'del', 'della', 'come', 'mio', 'più'],
  id: ['yang', 'dan', 'di', 'ini', 'itu', 'dengan', 'untuk', 'tidak', 'ada', 'saya', 'dari', 'akan', 'bisa', 'kita', 'aku', 'apa'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'da', 'de', 'ne', 'çok', 'gibi', 'nasıl', 'ben', 'en', 'mı', 'mi'],
  pl: ['i', 'w', 'na', 'nie', 'się', 'z', 'jest', 'to', 'do', 'że', 'jak', 'co', 'po', 'za', 'od'],
};

const LANGUAGE_NAMES: Record<string, string> = {
  hindi: 'hi', tamil: 'ta', telugu: 'te', malayalam: 'ml', kannada: 'kn', bhojpuri: 'bho', punjabi: 'pa',
  marathi: 'mr', bengali: 'bn', bangla: 'bn', urdu: 'ur', gujarati: 'gu', odia: 'or', haryanvi: 'bgc',
};

/** The Latin-script language a title is clearly in, or undefined when unsure. */
export function latinLanguage(title: string): string | undefined {
  const words = (title.toLowerCase().match(/[\p{L}']+/gu) ?? []).filter((w) => w.length > 1);
  if (words.length < 3) return undefined;
  const hits = new Map<string, number>();
  for (const [lang, list] of Object.entries(STOP_WORDS)) {
    const set = new Set(list);
    hits.set(lang, words.filter((w) => set.has(w)).length);
  }
  const ranked = [...hits].sort((a, b) => b[1] - a[1]);
  const [first, second] = ranked;
  if (!first || first[1] < 2) return undefined;
  return first[1] >= 2 * (second?.[1] ?? 0) ? first[0] : undefined;
}

/** A language the title names as its own ("Hindi Dubbed", "Tamil Movie"), if any. */
export function namedLanguage(title: string): string | undefined {
  for (const w of title.toLowerCase().match(/[a-z]+/g) ?? []) {
    const lang = LANGUAGE_NAMES[w];
    if (lang) return lang;
  }
  return undefined;
}

export interface LanguageCheck {
  /** The user's languages: UI language, region languages, and what their subscriptions upload in. */
  languages: Set<string>;
  /**
   * 'full' also rejects Latin-script titles clearly in another language. 'script' only checks
   * the script and named languages (for region-curated lists like the news, which are in the
   * region's language whatever the UI language is).
   */
  mode: 'full' | 'script';
}

/** Whether a title looks like it's in a language the user reads. Unsure means yes. */
export function readable(title: string, check: LanguageCheck): boolean {
  const langs = check.languages;
  if (!langs.size) return true;
  const named = namedLanguage(title);
  if (named && !langs.has(named)) return false;
  const script = dominantScript(title);
  if (script) {
    const ok = [...langs].some((l) => scriptsOf(l).includes(script));
    if (!ok) return false;
  }
  if (check.mode === 'full' && script === 'latin') {
    const lang = latinLanguage(title);
    if (lang && !langs.has(lang)) return false;
  }
  return true;
}

/**
 * The user's languages: YouTube UI language, the region's main languages, and any language at
 * least 15% of their subscription uploads are clearly in (an English UI on Dutch content, say).
 */
export function userLanguages(hl: string | undefined, region: string | undefined, subscriptionTitles: string[]): Set<string> {
  const out = new Set<string>(regionLanguages(region));
  const ui = baseLanguage(hl);
  if (ui) out.add(ui);
  const counts = new Map<string, number>();
  let known = 0;
  for (const t of subscriptionTitles) {
    const script = dominantScript(t);
    const lang = script === 'latin' ? latinLanguage(t) : script ? scriptLanguage(script) : undefined;
    if (!lang) continue;
    known++;
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  for (const [lang, n] of counts) if (known >= 5 && n / known >= 0.15) out.add(lang);
  return out;
}

/** A representative language for a non-Latin script (enough for the script check). */
function scriptLanguage(script: Script): string | undefined {
  for (const [lang, scripts] of Object.entries(LANGUAGE_SCRIPTS)) if (scripts[0] === script) return lang;
  return undefined;
}
