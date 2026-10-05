import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ownedPath } from './files.mjs';
import { narrative, references, statement, validateScenes } from './script.mjs';
import { inventory, verifyGame } from '../tools/verify-game.mjs';

const kit = fileURLToPath(new URL('..', import.meta.url));
const hash = data => createHash('sha256').update(data).digest('hex');
const ignoredAsset = value => !value || ['none', 'undefined', 'null'].includes(value);
const inside = (base, target) => { const rel = path.relative(base, target); return !rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)); };

// Check direct native asset references without rewriting the compiler's script.
export function verifyNativeAssets(game, scenes) {
  const assets = new Set();
  const add = (folder, value) => {
    if (ignoredAsset(value)) return;
    const file = path.posix.normalize(folder + '/' + value);
    ownedPath(game, file);
    if (!fs.existsSync(path.join(game, file)) || !fs.statSync(path.join(game, file)).isFile()) throw Error('Missing native asset ' + file);
    assets.add(file);
  };
  const commands = { changeBg:'background', changeFigure:'figure', bgm:'bgm', playEffect:'effect', playVideo:'video', unlockCg:'background' };
  for (const lines of Object.values(scenes)) for (const line of lines) {
    const s = statement(line), colon = s.indexOf(':');
    const command = s.slice(0, colon), value = s.slice(colon + 1).split(' -')[0].trim();
    if (Object.hasOwn(commands, command)) add(commands[command], value);
    for (const match of s.matchAll(/ -(vocal|backgroundImage)=([^\s;]+)/g)) add(match[1] === 'vocal' ? 'vocal' : 'background', match[2]);
  }
  for (const line of fs.readFileSync(path.join(game, 'config.txt'), 'utf8').split(/\r?\n/)) {
    const s = statement(line), colon = s.indexOf(':');
    const folders = { Title_img:'background', Title_bgm:'bgm', Game_Logo:'background' };
    if (Object.hasOwn(folders, s.slice(0, colon))) for (const file of s.slice(colon + 1).split('|')) add(folders[s.slice(0, colon)], file.trim());
  }
  return [...assets].sort();
}

export function importNativeGame({ game, output, checkpoints = [], gameKey }) {
  game = fs.realpathSync(game); output = path.resolve(output);
  const dist = path.dirname(game);
  if (path.basename(game) !== 'game') throw Error('Expected the compiler output game/ directory');
  if (inside(dist, output) || inside(output, game)) throw Error('Build output must be separate from the source dist');
  if (!Array.isArray(checkpoints) || checkpoints.length > 8) throw Error('Expected at most eight explicit checkpoints');
  const verified = verifyGame(dist), source = inventory(game), files = new Map();
  for (const row of source) { const file = ownedPath(game, row.file); files.set(row.file, fs.readFileSync(file)); }
  if (!files.has('config.txt')) throw Error('Missing native config.txt');
  const scenes = Object.fromEntries(verified.reachableScenes.map(name => [name, files.get('scene/' + name).toString('utf8').split(/\r?\n/)]));
  const assets = verifyNativeAssets(game, scenes), originalNarrative = Object.values(scenes).flat().filter(narrative);
  const inserts = new Map(), slots = new Set();
  if (checkpoints.length) {
    if (!/^[A-Za-z0-9_-]+$/.test(gameKey ?? '')) throw Error('Checkpoints require a distinct --game-key');
    const cfg = files.get('config.txt').toString('utf8'), keys = [...cfg.matchAll(/^Game_key:([^;]+);/gmi)];
    if (keys.length !== 1 || keys[0][1] === gameKey) throw Error('Expected one Game_key and a new key for the checkpoint build');
    if (Object.values(scenes).flat().some(line => /(?:_release_checkpoint|_production_checkpoint_)/.test(line))) throw Error('Source already contains checkpoint integration');
    files.set('config.txt', Buffer.from(cfg.replace(/^Game_key:[^;]+;/gmi, `Game_key:${gameKey};`)));
    for (const checkpoint of checkpoints) {
      const { scene, after, slot } = checkpoint;
      if (!Object.hasOwn(scenes, scene) || typeof after !== 'string' || !after.trim() || /[\r\n]/.test(after)) throw Error('Invalid checkpoint scene or exact after line');
      if (/^(?:end(?::|;|$)|changeScene:|jumpLabel:|choose:)/.test(statement(after))) throw Error('Checkpoint must follow a fall-through instruction');
      if (!Number.isInteger(slot) || slot < 1 || slot > 8 || slots.has(slot)) throw Error('Checkpoint slots must be unique integers 1–8');
      slots.add(slot);
      const matches = scenes[scene].flatMap((line, i) => line === after ? [i] : []);
      if (matches.length !== 1) throw Error(`Checkpoint anchor must match exactly once in ${scene}`);
      if (inserts.get(scene)?.has(matches[0])) throw Error('Two checkpoints share the same anchor');
      if (!inserts.has(scene)) inserts.set(scene, new Map());
      inserts.get(scene).set(matches[0], slot);
    }
    for (const [name, points] of inserts) {
      const lines = scenes[name].flatMap((line, i) => points.has(i) ? [line, `setVar:_release_checkpoint=${points.get(i)};`, `choose:章节自动存档中:_production_checkpoint_${points.get(i)};`, `label:_production_checkpoint_${points.get(i)};`, 'setVar:_release_checkpoint=0;'] : [line]);
      scenes[name] = lines; files.set('scene/' + name, Buffer.from(lines.join('\n')));
    }
    files.set('release-runtime.js', fs.readFileSync(path.join(kit, 'runtime/release-runtime.js')));
    const css = files.get('userStyleSheet.css')?.toString('utf8') ?? '';
    files.set('userStyleSheet.css', Buffer.from(css + '\n/* Production native checkpoint extension */\n' + fs.readFileSync(path.join(kit, 'runtime/native-ui.css'), 'utf8')));
  } else if (gameKey) throw Error('--game-key is only used with --checkpoints');
  validateScenes(scenes);
  if (JSON.stringify(Object.values(scenes).flat().filter(narrative)) !== JSON.stringify(originalNarrative)) throw Error('Native import changed narrative');
  const names = [...files.keys()].sort(), previousFile = path.join(output, 'owned-files.json');
  if (fs.existsSync(output) && fs.readdirSync(output).length && !fs.existsSync(path.join(output, '.native-import'))) throw Error('Refusing unmanaged output directory');
  const previous = fs.existsSync(previousFile) ? JSON.parse(fs.readFileSync(previousFile, 'utf8')) : [];
  for (const name of [...previous, ...names]) ownedPath(output, 'game/' + name);
  for (const name of previous) if (!files.has(name)) fs.rmSync(ownedPath(output, 'game/' + name), { force:true });
  for (const [name, data] of files) { const dest = ownedPath(output, 'game/' + name); fs.mkdirSync(path.dirname(dest), { recursive:true }); fs.writeFileSync(dest, data); }
  const report = { schemaVersion:1, mode:'native-import', sourceFiles:source, outputFiles:names.map(file => ({ file, sha256:hash(files.get(file)) })), narrativeInvariant:true, narrativeLines:originalNarrative.length, reachableScenes:verified.reachableScenes, assets, checkpoints, runtime:files.has('release-runtime.js'), graph:Object.entries(scenes).map(([scene, lines]) => ({ scene, next:references(lines).scenes })) };
  fs.writeFileSync(path.join(output, '.native-import'), 'webgal-screenplay-compiler\n');
  fs.writeFileSync(previousFile, JSON.stringify(names, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'assembly-report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
