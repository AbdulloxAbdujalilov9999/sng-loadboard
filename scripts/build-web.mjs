// Builds web/ into web/dist: compiled Tailwind CSS, self-hosted vendor libs, cache-busted index.html.
//   npm run build:web
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web');
const dist = path.join(web, 'dist');
const nm = (...p) => path.join(root, 'node_modules', ...p);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'js'), { recursive: true });
fs.mkdirSync(path.join(dist, 'vendor'), { recursive: true });

// 1. CSS
execFileSync(process.execPath, [nm('tailwindcss', 'lib', 'cli.js'), '-c', path.join(root, 'tailwind.config.cjs'),
  '-i', path.join(web, 'src', 'styles.css'), '-o', path.join(dist, 'styles.css'), '--minify'], { stdio: 'inherit', cwd: root });

// 2. App scripts + static files
for (const f of fs.readdirSync(path.join(web, 'js'))) fs.copyFileSync(path.join(web, 'js', f), path.join(dist, 'js', f));
if (fs.existsSync(path.join(web, 'public'))) {
  for (const f of fs.readdirSync(path.join(web, 'public'))) fs.copyFileSync(path.join(web, 'public', f), path.join(dist, f));
}

// 3. Vendor libraries, self-hosted (no third-party CDN at runtime except Firebase Auth itself)
const vendor = [
  [nm('lucide', 'dist', 'umd', 'lucide.min.js'), 'lucide.min.js'],
  [nm('flatpickr', 'dist', 'flatpickr.min.js'), 'flatpickr.min.js'],
  [nm('flatpickr', 'dist', 'flatpickr.min.css'), 'flatpickr.min.css'],
  [nm('flatpickr', 'dist', 'themes', 'material_blue.css'), 'flatpickr-theme.css'],
  [nm('flatpickr', 'dist', 'l10n', 'ru.js'), 'flatpickr-ru.js'],
];
for (const [src, name] of vendor) fs.copyFileSync(src, path.join(dist, 'vendor', name));

// 4. index.html with a content hash so browsers never run stale JS/CSS after a deploy
const hash = crypto.createHash('sha1');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
for (const f of walk(dist)) hash.update(fs.readFileSync(f));
hash.update(fs.readFileSync(path.join(web, 'index.html')));
const version = hash.digest('hex').slice(0, 10);
fs.writeFileSync(path.join(dist, 'index.html'), fs.readFileSync(path.join(web, 'index.html'), 'utf8').replaceAll('__BUILD__', version));
console.log(`web built -> ${path.relative(root, dist)} (build ${version})`);
