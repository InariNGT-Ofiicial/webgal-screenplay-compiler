import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble } from '../src/assembly.mjs';
import { assetPath, digest } from '../src/presentation.mjs';
import { ownedPath } from '../src/files.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const [manifest, ...args] = process.argv.slice(2);
if (!manifest) throw Error('Usage: node tools/build.mjs <project.json> [--out build/demo] [--assets <asset-root>] [--accept-anchors]');
const option = name => { const i = args.indexOf(name); if (i >= 0 && (!args[i + 1] || args[i + 1].startsWith('--'))) throw Error(`Missing value for ${name}`); return i < 0 ? null : args[i + 1]; };
const project = JSON.parse(fs.readFileSync(manifest, 'utf8')), output = path.resolve(option('--out') ?? 'build/demo');
if (!project.gameKey || !/^[A-Za-z0-9_-]+$/.test(project.gameKey) || !project.name || /[;\r\n]/.test(project.name)) throw Error('Provide a safe name and distinct gameKey');
const built = assemble(project), lockFile = path.join(output, 'anchors.lock.json');
if (fs.existsSync(lockFile) && digest(JSON.parse(fs.readFileSync(lockFile, 'utf8'))) !== digest(built.anchorLock) && !args.includes('--accept-anchors')) throw Error('Canonical anchors changed. Review source and cues, then rebuild with --accept-anchors.');
if (fs.existsSync(output) && fs.readdirSync(output).length && !fs.existsSync(path.join(output, '.production-build'))) throw Error('Refusing to write into an unmanaged output directory');
const game = path.join(output, 'game'), assets = option('--assets');
// Preflight the entire build before writing anything.
if (assets) for (const file of built.assets) if (!fs.statSync(path.join(assets, file)).isFile()) throw Error(`Missing asset ${file}`);
const files = {};
for (const [name, lines] of Object.entries(built.scenes)) files['scene/' + name] = lines.join('\n') + '\n';
files['config.txt'] = `Game_name:${project.name};\nGame_key:${project.gameKey};\nTitle_img:${assetPath(project.titleImage ?? 'title.png')};\nEnable_Appreciation:true;\nEnable_Continue:true;\nEnable_flowchart:false;\n` + (project.titleMusic ? `Title_bgm:${assetPath(project.titleMusic)};\n` : '');
if (assets && !fs.existsSync(path.join(assets, 'background', project.titleImage ?? 'title.png'))) throw Error('Missing title image');
if (assets && project.titleMusic && !fs.existsSync(path.join(assets, 'bgm', project.titleMusic))) throw Error('Missing title music');
const runtime = fs.readFileSync(path.join(root, 'runtime/release-runtime.js'), 'utf8');
files['release-runtime.js'] = runtime;
files['userStyleSheet.css'] = fs.readFileSync(path.join(root, 'runtime/native-ui.css'), 'utf8');
fs.mkdirSync(game, { recursive:true });
const inventoryFile = path.join(output, 'owned-files.json');
const previous = fs.existsSync(inventoryFile) ? JSON.parse(fs.readFileSync(inventoryFile, 'utf8')) : [];
const owned = [...Object.keys(files), ...(assets ? [...built.assets, 'background/' + (project.titleImage ?? 'title.png'), ...(project.titleMusic ? ['bgm/' + project.titleMusic] : [])] : [])];
for (const file of [...previous, ...owned]) ownedPath(output, 'game/' + file);
for (const old of previous) if (!owned.includes(old)) fs.rmSync(ownedPath(output, 'game/' + old), { force:true });
for (const [file, text] of Object.entries(files)) { const dest = ownedPath(output, 'game/' + file); fs.mkdirSync(path.dirname(dest), { recursive:true }); fs.writeFileSync(dest, text); }
if (assets) for (const file of owned.filter(f => !Object.hasOwn(files, f))) { const dest = ownedPath(output, 'game/' + file); fs.mkdirSync(path.dirname(dest), { recursive:true }); fs.copyFileSync(path.join(assets, file), dest); }
fs.writeFileSync(path.join(output, '.production-build'), 'WebGAL-Production-Kit\n');
fs.writeFileSync(lockFile, JSON.stringify(built.anchorLock, null, 2) + '\n');
fs.writeFileSync(inventoryFile, JSON.stringify([...new Set(owned)].sort(), null, 2) + '\n');
fs.writeFileSync(path.join(output, 'assembly-report.json'), JSON.stringify(built.report, null, 2) + '\n');
console.log(JSON.stringify({ scenes:built.report.scenes, narrativeLines:built.report.narrativeLines, invariant:built.report.narrativeInvariant, assetsCopied:!!assets }));
