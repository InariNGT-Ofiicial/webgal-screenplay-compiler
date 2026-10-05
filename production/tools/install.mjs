import fs from 'node:fs';
import path from 'node:path';
import { ownedPath } from '../src/files.mjs';
const [buildArg, distArg, mode] = process.argv.slice(2);
if (!buildArg || !distArg) throw Error('Usage: node tools/install.mjs <build-dir> <WebGAL-dist> [--restore]');
const build = path.resolve(buildArg), dist = fs.realpathSync(distArg), backup = path.join(dist, '.production-backup');
const safe = relative => ownedPath(dist, relative);
if (mode === '--restore') {
  const records = JSON.parse(fs.readFileSync(path.join(backup, 'records.json'), 'utf8'));
  for (const record of records) { safe(record.file); ownedPath(dist, '.production-backup/' + record.file); }
  for (const record of records) { const target = safe(record.file); if (record.existed) fs.copyFileSync(path.join(backup, record.file), target); else fs.rmSync(target, { force:true }); }
  fs.rmSync(path.join(backup, 'records.json')); console.log('Original files restored; backup copies retained.');
} else {
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw Error('Expected a WebGAL dist containing index.html');
  if (fs.existsSync(path.join(backup, 'records.json'))) throw Error('An overlay is installed. Restore it before installing another build.');
  const files = JSON.parse(fs.readFileSync(path.join(build, 'owned-files.json'), 'utf8')), records = [];
  for (const file of files) { safe('game/' + file); if (!fs.statSync(ownedPath(build, 'game/' + file)).isFile()) throw Error('Missing built file ' + file); }
  for (const file of files) {
    const rel = 'game/' + file, target = safe(rel), copy = ownedPath(dist, '.production-backup/' + rel), existed = fs.existsSync(target);
    if (existed) { fs.mkdirSync(path.dirname(copy), { recursive:true }); fs.copyFileSync(target, copy); }
    records.push({ file:rel, existed });
  }
  fs.mkdirSync(backup, { recursive:true }); fs.writeFileSync(path.join(backup, 'records.json'), JSON.stringify(records, null, 2));
  for (const file of files) { const target = safe('game/' + file); fs.mkdirSync(path.dirname(target), { recursive:true }); fs.copyFileSync(path.join(build, 'game', file), target); }
  console.log(`Installed ${files.length} project files; upstream bundles unchanged.`);
}
