import fs from 'node:fs';
import { importNativeGame } from '../src/native-import.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error('Missing value for ' + name); return args[i + 1]; };
if (args.includes('--help')) {
  console.log('node production/tools/import-game.mjs [--game <game-dir>] [--out <build-dir>] [--checkpoints <json-array>] [--game-key <new-key>]');
} else {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const points = option('--checkpoints');
  const game = option('--game') ?? path.dirname((await import('../../compiler/paths.mjs')).SCENE_DIR);
  const report = importNativeGame({ game, output:option('--out') ?? path.join(root, 'build/production'), checkpoints:points ? JSON.parse(fs.readFileSync(points, 'utf8')) : [], gameKey:option('--game-key') });
  console.log(JSON.stringify({ mode:report.mode, files:report.outputFiles.length, scenes:report.reachableScenes.length, narrativeInvariant:report.narrativeInvariant, checkpoints:report.checkpoints.length }));
}
