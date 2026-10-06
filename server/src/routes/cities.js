import { citiesQuery } from '../lib/schemas.js';
import { cityDto } from '../lib/dto.js';

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export default async function cityRoutes(app, { pool }) {
  // Autocomplete: accepts "tash", "Ташкент", or a full label like "Tashkent, UZ".
  // Ranking: name starts with the text, then a word starts with it, then anywhere.
  app.get('/api/cities', { preHandler: app.guards.approved }, async (req, reply) => {
    const q = citiesQuery.parse(req.query);
    const [namePart = '', ccPart = ''] = q.q.split(',').map((s) => s.trim());
    const country = /^[A-Za-z]{2}$/.test(ccPart) ? ccPart.toUpperCase() : null;
    const needle = escapeLike(namePart.toLowerCase());

    const { rows } = await pool.query(
      `SELECT id, name, name_ru, country, label, lat, lng,
              CASE WHEN search_key LIKE $1 THEN 0 WHEN search_key LIKE $2 THEN 1 ELSE 2 END AS rank
         FROM cities
        WHERE ($4 = '' OR search_key LIKE $3) AND ($5::text IS NULL OR country = $5)
        ORDER BY rank, name
        LIMIT $6`,
      [`${needle}%`, `% ${needle}%`, `%${needle}%`, namePart, country, q.limit],
    );
    reply.header('Cache-Control', 'private, max-age=300');
    return { items: rows.map(cityDto) };
  });
}
