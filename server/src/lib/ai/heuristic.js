// Offline, rule-based reader for the common "flag / flag / cargo / truck / terms / phone" post layout.
// It is NOT the AI: used only by the local dev server (no API key needed) and in tests. It yields the same
// "raw loads" shape as the Gemini parser so everything after it (city matching, review, posting) is identical.

const FLAG = /\p{Regional_Indicator}{2}/u;
const PHONE = /\+?\d[\d\s().-]{7,}\d/;
const EQUIP_WORDS = [
  ['AC', /АВТОВОЗ|AVTOVOZ/i], ['R', /РЕФ|REF\b|REFRIG/i], ['V', /ФУРГОН|ИЗОТЕРМ|ISOTHERM|\bVAN\b/i],
  ['F', /БОРТ|ОТКРЫТ|ШАЛАНД|FLAT/i], ['T', /ТЕНТ|ШТОРА|TENT|ФУРА|FURA/i],
];
const TERMS = /ОПЛАТА|ТЎЛОВ|TO'?LOV|ПОГРУЗКА|YUKLASH|АВАНС|AVANS|НАХТ|НАКД|ГОТОВ|ТАЙЁР|ТАЙЙОР|TAYYOR/i;

export function createHeuristicParser() {
  return {
    name: 'heuristic',
    async parseLoads({ text }) {
      const loads = [];
      for (const block of String(text).split(/\n\s*\n+/)) {
        const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
        const places = lines.filter((l) => FLAG.test(l)).map((l) => l.replace(/\p{Regional_Indicator}/gu, '').trim()).filter(Boolean);
        if (places.length < 2) continue;
        const rest = lines.filter((l) => !FLAG.test(l));
        const phone = rest.map((l) => PHONE.exec(l)?.[0]).find(Boolean);
        const body = rest.filter((l) => !PHONE.test(l) || /[A-Za-zА-Яа-я]/.test(l.replace(PHONE, '')));
        // Keep the order the sender wrote them in (the first one becomes the primary trailer type).
        const joined = body.join('\n');
        const equipment = EQUIP_WORDS.map(([code, re]) => [code, joined.search(re)]).filter(([, at]) => at >= 0)
          .sort((a, b) => a[1] - b[1]).map(([code]) => code);
        const terms = body.filter((l) => TERMS.test(l));
        const commodityLine = body.find((l) => !TERMS.test(l) && !EQUIP_WORDS.some(([, re]) => re.test(l)));
        loads.push({
          origin: { place: places[0], cityLabel: null },
          destinations: places.slice(1).map((place) => ({ place, cityLabel: null })),
          equipment: equipment.length ? equipment : ['T'],
          fullOrPartial: 'Full',
          weightT: null, pickupDate: null, rateUsd: null,
          commodity: commodityLine || 'General cargo',
          notes: terms.join(' · '),
          phone: phone ? phone.replace(/[^\d+]/g, '') : null,
          telegram: null, contactName: null,
        });
      }
      return { loads };
    },
  };
}
