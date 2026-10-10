// Offline, rule-based reader for the common chat layouts (flag / flag / cargo / truck / terms / phone). It is NOT the AI:
// it is the "basic mode" used when no Gemini key is set, by the local dev server, and in tests. It produces the same
// "raw" shape as the Gemini parser, so everything after it (city matching, review, posting) is identical.

const FLAG = /\p{Regional_Indicator}{2}/u;
const FLAG_G = /\p{Regional_Indicator}{2}/gu;
const PHONE = /\+?\d[\d\s().-]{7,}\d/;
const EQUIP_WORDS = [
  ['AC', /АВТОВОЗ|AVTOVOZ/i], ['R', /РЕФ|REF\b|REFRIG/i], ['V', /ФУРГОН|ИЗОТЕРМ|ISOTHERM|\bVAN\b/i],
  ['F', /БОРТ|ОТКРЫТ|ШАЛАНД|FLAT/i], ['T', /ТЕНТ|ШТОРА|TENT|ФУРА|FURA/i],
];
const TERMS = /ОПЛАТА|ТЎЛОВ|TO'?LOV|ПОГРУЗКА|YUKLASH|АВАНС|AVANS|НАХТ|НАКД|ГОТОВ|ТАЙЁР|ТАЙЙОР|TAYYOR/i;

/** 🇷🇺 -> "RU": a flag emoji IS the two letters of the ISO country code (regional indicator symbols). */
export function flagCountry(text) {
  const m = String(text).match(FLAG);
  if (!m) return null;
  return [...m[0]].map((ch) => String.fromCharCode(ch.codePointAt(0) - 0x1F1E6 + 65)).join('');
}

const stripFlags = (s) => s.replace(FLAG_G, '').trim();
const place = (line) => ({ text: stripFlags(line), city: stripFlags(line), country: flagCountry(line), region: null, lat: null, lng: null });
const blocksOf = (text) => String(text).split(/\n\s*\n+/);
const linesOf = (block) => block.split('\n').map((l) => l.trim()).filter(Boolean);
const phoneOf = (lines) => { const p = lines.map((l) => PHONE.exec(l)?.[0]).find(Boolean); return p ? p.replace(/[^\d+]/g, '') : null; };
const equipmentOf = (lines) => {
  // Keep the order the sender wrote them in (the first one becomes the primary trailer type).
  const joined = lines.join('\n');
  return EQUIP_WORDS.map(([code, re]) => [code, joined.search(re)]).filter(([, at]) => at >= 0).sort((a, b) => a[1] - b[1]).map(([code]) => code);
};

function nextDate(day, month, today) {
  const t = new Date(`${today}T00:00:00Z`);
  let d = new Date(Date.UTC(t.getUTCFullYear(), month - 1, day));
  if (d < t) d = new Date(Date.UTC(t.getUTCFullYear() + 1, month - 1, day));
  return Number.isFinite(d.getTime()) && d.getUTCMonth() === month - 1 ? d.toISOString().slice(0, 10) : null;
}

export function createHeuristicParser() {
  return {
    name: 'heuristic',

    async parseLoads({ text }) {
      const loads = [];
      for (const block of blocksOf(text)) {
        const lines = linesOf(block);
        const placeLines = lines.filter((l) => FLAG.test(l));
        if (placeLines.length < 2) continue;
        const rest = lines.filter((l) => !FLAG.test(l));
        const body = rest.filter((l) => !PHONE.test(l) || /[A-Za-zА-Яа-я]/.test(l.replace(PHONE, '')));
        const equipment = equipmentOf(body);
        const terms = body.filter((l) => TERMS.test(l));
        const commodityLine = body.find((l) => !TERMS.test(l) && !EQUIP_WORDS.some(([, re]) => re.test(l)));
        loads.push({
          origin: place(placeLines[0]),
          destinations: placeLines.slice(1).map(place),
          equipment: equipment.length ? equipment : ['T'],
          fullOrPartial: 'Full',
          weightT: null, pickupDate: null, rateUsd: null,
          commodity: commodityLine || 'General cargo',
          notes: terms.join(' · '),
          phone: phoneOf(rest),
          telegram: null, contactName: null,
        });
      }
      return { loads };
    },

    async parseTrucks({ text, today }) {
      const trucks = [];
      for (const block of blocksOf(text)) {
        const lines = linesOf(block);
        const placeLines = lines.filter((l) => FLAG.test(l));
        if (!placeLines.length) continue;
        // "🇺🇿 САМАРКАНД → 🇷🇺 МОСКВА" on ONE line, or the location and destination on separate lines
        let parts = [];
        for (const l of placeLines) parts.push(...stripFlags(l).split(/\s*(?:→|➡️?|>|—|–|\s-\s)\s*/).filter(Boolean).map((p) => ({ text: p, country: flagCountry(l) })));
        if (placeLines.length === 1 && parts.length === 2) { const cs = [...placeLines[0].matchAll(FLAG_G)].map((m) => flagCountry(m[0])); parts = parts.map((p, i) => ({ ...p, country: cs[i] ?? cs[0] ?? null })); }
        const rest = lines.filter((l) => !FLAG.test(l));
        const all = lines.join('\n');
        const cap = /(\d{1,3}(?:[.,]\d+)?)\s*(?:т\b|тн|тонн|t\b|ton|tn)/i.exec(all);
        const vol = /(\d{2,3})\s*(?:куб|м3|м³|m3|m³|cbm)/i.exec(all);
        const date = /(\d{1,2})[./](\d{1,2})(?![\d])/.exec(rest.join(' '));
        const loc = parts[0];
        trucks.push({
          location: { text: loc.text, city: loc.text, country: loc.country, region: null, lat: null, lng: null },
          destinationText: parts.slice(1).map((p) => p.text).join(' / ') || null,
          equipment: equipmentOf(rest.length ? rest : lines),
          capacityT: cap ? Number(cap[1].replace(',', '.')) : null,
          volumeM3: vol ? Number(vol[1]) : null,
          availableFrom: date ? nextDate(Number(date[1]), Number(date[2]), today) : /СВОБОД|ГОТОВ|READY|FREE|BO.?SH|TAYYOR|ТАЙЁР|ТАЙЙОР/i.test(all) ? today : null,
          availableTo: null,
          minRateUsd: null,
          hasTir: /\bTIR\b|МДП|ТИР\b/i.test(all),
          hasAdr: /\bADR\b|ДОПОГ|ОПАСН/i.test(all),
          hasGps: /\bGPS\b|ГЛОНАСС/i.test(all),
          sideLoading: /БОКОВ|ВЕРХН|SIDE/i.test(all),
          notes: rest.filter((l) => !(PHONE.test(l) && !/[A-Za-zА-Яа-я]/.test(l.replace(PHONE, ''))))        // not a bare phone line
            .filter((l) => !EQUIP_WORDS.some(([, re]) => re.test(l)) && !(cap && l.includes(cap[0])) && !(vol && l.includes(vol[0]))).join(' · ').slice(0, 300),
          phone: phoneOf(rest),
          telegram: null, contactName: null,
        });
      }
      return { trucks };
    },
  };
}
