import { citiesQuery } from '../lib/schemas.js';
import { cityDto } from '../lib/dto.js';
import { searchCities } from '../lib/ai/cities.js';

export default async function cityRoutes(app) {
  // Autocomplete: understands "tash", "Ташкент", "Toshkent", "Xorazm" (a region -> its main city), a full label such as
  // "Tashkent, UZ", and small spelling mistakes. Served from memory (the whole list is ~2,000 rows).
  app.get('/api/cities', { preHandler: app.guards.approved }, async (req, reply) => {
    const q = citiesQuery.parse(req.query);
    const [namePart = '', ccPart = ''] = q.q.split(',').map((s) => s.trim());
    const country = /^[A-Za-z]{2}$/.test(ccPart) ? ccPart.toUpperCase() : null;
    const index = await app.cityIndex();
    const hits = searchCities(index, namePart, { limit: q.limit, country });
    reply.header('Cache-Control', 'private, max-age=300');
    return { items: hits.map((h) => cityDto(h.city, h.note)) };
  });
}
