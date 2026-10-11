import { citiesQuery } from '../lib/schemas.js';
import { cityDto } from '../lib/dto.js';
import { searchCities } from '../lib/ai/cities.js';
import { searchCountries } from '../lib/ai/countries.js';

export default async function cityRoutes(app) {
  // Autocomplete: understands "tash", "Ташкент", "Toshkent", "Xorazm" (a region -> its main city), a full label such as
  // "Tashkent, UZ", and small spelling mistakes. Served from memory (the whole list is ~2,000 rows).
  app.get('/api/cities', { preHandler: app.guards.active }, async (req, reply) => {
    const q = citiesQuery.parse(req.query);
    const index = await app.cityIndex();
    const hits = searchCities(index, q.q, { limit: q.limit });
    reply.header('Cache-Control', 'private, max-age=300');
    const cities = hits.map((h) => cityDto(h.city, h.note));
    if (q.countries !== '1') return { items: cities };
    // search filters may also pick a whole country (UZ, "Узбекистан", "Oʻzbekiston" ...): a clear match goes on top
    const available = new Set(index.cities.map((c) => String(c.country).trim()));
    const { top, rest } = searchCountries(q.q, available);
    return { items: [...top, ...cities, ...rest].slice(0, q.limit) };
  });
}
