// Countries as search targets ("loads from UZ to KZ"): typed in English, Russian, Uzbek or as the 2-letter code.
import { fold } from './cities.js';

// cc | English | Russian | Uzbek | other spellings
const TABLE = `
UZ|Uzbekistan|Узбекистан|Oʻzbekiston|Ozbekiston; Uzbekiston; Ўзбекистан; Uzbek
KZ|Kazakhstan|Казахстан|Qozogʻiston|Qazaqstan; Kazahstan; Қазақстан; Kazakh
KG|Kyrgyzstan|Киргизия|Qirgʻiziston|Кыргызстан; Kirgiziya; Kirgizstan; Kyrgyz
TJ|Tajikistan|Таджикистан|Tojikiston|Tadzhikistan; Тоҷикистон; Tadjikistan
TM|Turkmenistan|Туркменистан|Turkmaniston|Turkmeniya; Туркмения; Turkmen
RU|Russia|Россия|Rossiya|Russian Federation; РФ; Rossiia; Rus
BY|Belarus|Беларусь|Belarus|Белоруссия; Belorussiya; Byelorussia
UA|Ukraine|Украина|Ukraina|Україна; Ukrayina
AZ|Azerbaijan|Азербайджан|Ozarbayjon|Azerbaycan; Azerbaidzhan
AM|Armenia|Армения|Armaniston|Armeniya; Հայաստան
GE|Georgia|Грузия|Gruziya|Sakartvelo; Gurjiston
MD|Moldova|Молдова|Moldova|Moldavia; Молдавия
TR|Turkey|Турция|Turkiya|Türkiye; Turkiye; Turtsiya
IR|Iran|Иран|Eron|Persia
AF|Afghanistan|Афганистан|Afgʻoniston|Afganistan; Afgoniston
CN|China|Китай|Xitoy|Kitai; Chin
MN|Mongolia|Монголия|Moʻgʻuliston|Mongoliya; Mongolistan
PL|Poland|Польша|Polsha|Polska
DE|Germany|Германия|Germaniya|Deutschland
RO|Romania|Румыния|Ruminiya|România
BG|Bulgaria|Болгария|Bolgariya|България
LT|Lithuania|Литва|Litva|Lietuva
LV|Latvia|Латвия|Latviya|Latvija
EE|Estonia|Эстония|Estoniya|Eesti
`.trim().split('\n').map((line) => {
  const [cc, en, ru, uz, alt = ''] = line.split('|');
  const names = [en, ru, uz, ...alt.split(/\s*;\s*/)].filter(Boolean);
  return { cc, en, ru, uz, keys: [...new Set(names.map(fold).filter(Boolean))], code: cc.toLowerCase() };
});

export const countryDto = (c) => ({ id: `country:${c.cc}`, kind: 'country', country: c.cc, label: c.en, name: c.en, nameRu: c.ru, nameUz: c.uz });

/**
 * Countries matching what was typed: the 2-letter code, a full name, or the start of a name (3+ letters).
 * Returns { top, rest }: `top` matches exactly / by a clear prefix and goes above the cities; `rest` is a weak match.
 */
export function searchCountries(query, available = null) {
  const q = fold(query);
  if (!q) return { top: [], rest: [] };
  const top = []; const rest = [];
  for (const c of TABLE) {
    if (available && !available.has(c.cc)) continue;
    if (q === c.code || c.keys.includes(q)) top.push(c);
    else if (q.length >= 3 && c.keys.some((k) => k.startsWith(q))) top.push(c);
    else if (q.length >= 2 && c.keys.some((k) => k.startsWith(q))) rest.push(c);
  }
  return { top: top.map(countryDto), rest: rest.map(countryDto) };
}
