// Fills a DEVELOPMENT database with approved demo members + loads + trucks.
//   npm run seed                      # 5,000 loads / 1,000 trucks
//   npm run seed -- --loads 50000
// Refuses to run against NODE_ENV=production.
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { insertLoads, insertMembers, insertTrucks } from './lib/generate.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : def;
};

const config = loadConfig();
if (config.isProd) { console.error('Refusing to seed a production database.'); process.exit(1); }
const pool = createPool(config);
try {
  await runMigrations(pool, console);
  const owners = await insertMembers(pool, { count: arg('members', 40), prefix: 'demo' });
  const loads = await insertLoads(pool, { count: arg('loads', 5000), owners, onProgress: (d, t) => process.stdout.write(`\rloads ${d}/${t}`) });
  const trucks = await insertTrucks(pool, { count: arg('trucks', 1000), owners });
  await pool.query('ANALYZE loads; ANALYZE trucks');
  console.log(`\nSeeded ${owners.length} members, ${loads} loads, ${trucks} trucks (emails demo1..demoN@example.com).`);
} finally {
  await pool.end();
}
