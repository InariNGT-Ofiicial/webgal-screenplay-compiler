import { createHash } from 'node:crypto';
import { escapeText, narrative } from './script.mjs';
import { figureTransform } from './portrait.mjs';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function assetPath(file) {
  if (typeof file !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(file) || file.startsWith('/') || file.split('/').some(x => !x || x === '.' || x === '..')) throw Error(`Invalid asset path: ${file}`);
  return file;
}
export function formatLine(line, display = {}) {
  const n = narrative(line); if (!n) return line;
  if ((display.omit ?? []).includes(n.text)) return '; explicit display omission';
  let text = Object.hasOwn(display.replace ?? {}, n.text) ? display.replace[n.text] : n.text;
  for (const { base, note } of display.ruby ?? []) for (const [open, close] of [['（', '）'], ['(', ')']]) text = text.replaceAll(`${base}${open}${note}${close}`, `[${base}](${note})`);
  if (text === n.text) return line;
  return n.prefix + text + n.suffix;
}
export function compilePresentation(project) {
  if (project.schemaVersion !== 1 || !Array.isArray(project.chapters) || !project.chapters.length) throw Error('Expected schemaVersion 1 and nonempty chapters');
  const beats = project.chapters.flatMap(c => c.beats), index = new Map();
  for (const [i, beat] of beats.entries()) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(beat.id) || index.has(beat.id) || !Array.isArray(beat.lines) || !beat.lines.every(l => typeof l === 'string' && !/[\r\n]/.test(l))) throw Error(`Invalid or duplicate beat ${beat.id}`);
    if (beat.lines.some(l => /^(?:changeBg|changeFigure|bgm|playEffect):/.test(l.trim()))) throw Error(`Stage instructions belong in cues, not canonical beat ${beat.id}`);
    index.set(beat.id, i);
  }
  const at = id => { if (id === '$end') return beats.length; if (!index.has(id)) throw Error(`Unknown beat anchor ${id}`); return index.get(id); };
  const cues = project.cues ?? {}, characters = project.characters ?? {}, assets = new Set();
  const asset = (folder, file) => { assets.add(`${folder}/${assetPath(file)}`); return file; };
  const ranges = (rows, kind) => {
    const result = (rows ?? []).map(row => ({ ...row, start: at(row.from), stop: at(row.to) })).sort((a, b) => a.start - b.start);
    for (let i = 0; i < result.length; i++) if (result[i].start >= result[i].stop || (i && result[i].start < result[i - 1].stop)) throw Error(`Invalid or overlapping ${kind} range`);
    return result;
  };
  const shots = ranges(cues.shots, 'CG'), blackouts = ranges(cues.blackouts, 'blackout'), musicRanges = ranges(cues.musicRanges, 'music');
  const group = rows => { const map = new Map(); for (const row of rows ?? []) { const i = at(row.at); if (i === beats.length) throw Error('Event cannot anchor at $end'); map.set(i, [...(map.get(i) ?? []), row]); } return map; };
  const backgrounds = group(cues.backgrounds), presence = group(cues.presence), music = group(cues.music), sounds = group(cues.sounds);
  for (const row of cues.backgrounds ?? []) asset('background', row.file);
  for (const row of shots) asset('cg', row.file);
  for (const row of [...(cues.music ?? []), ...musicRanges]) if (row.file !== 'none') asset('bgm', row.file);
  for (const row of cues.sounds ?? []) asset('effect', row.file);
  if (blackouts.length) asset('background', project.blackBackground ?? 'black.png');
  for (const [id, actor] of Object.entries(characters)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) throw Error(`Invalid character id ${id}`);
    asset('figure', actor.file); figureTransform(actor.profile, 'left', project.framing);
  }
  const volume = value => { const n = value ?? 85; if (!Number.isFinite(n) || n < 0 || n > 100) throw Error('Volume must be between 0 and 100'); return n; };
  const out = []; let emitted = [], bg = null, shownBg = null, activeMusic = null, baseMusic = { file: 'none' }, activeShot = null, wasBlack = false;
  const present = new Map(), visible = new Map(), retired = new Set();
  const emit = line => emitted.push(line);
  const hide = id => { if (visible.has(id)) { emit(`changeFigure: -id=${id} -duration=0 -next;`); visible.delete(id); } };
  const hideAll = () => { for (const id of [...visible.keys()]) hide(id); };
  const enter = (id, side) => {
    if (!Object.hasOwn(characters, id)) throw Error(`Unknown character ${id}`);
    if (retired.has(id)) throw Error(`Retired character cannot re-enter: ${id}`);
    if (!['left', 'right'].includes(side)) throw Error('Only left and right portrait slots are supported');
    for (const [other, otherSide] of present) if (other !== id && side === otherSide) { hide(other); present.delete(other); }
    if (present.has(id) && present.get(id) !== side) hide(id);
    present.set(id, side);
  };
  const show = (id, side) => {
    if (visible.get(id) === side) return;
    const actor = characters[id], transform = figureTransform(actor.profile, side, project.framing);
    emit(`changeFigure:${actor.file} -id=${id} -transform=${JSON.stringify(transform)} -duration=180 -next;`); visible.set(id, side);
  };
  const displays = [];
  for (const [i, beat] of beats.entries()) {
    emitted = [];
    for (const row of backgrounds.get(i) ?? []) { bg = row.file; if (row.clearPresence !== false) { hideAll(); present.clear(); } }
    for (const row of presence.get(i) ?? []) {
      for (const id of [...(row.exit ?? []), ...(row.retire ?? [])]) { if (!Object.hasOwn(characters, id)) throw Error(`Unknown character ${id}`); hide(id); present.delete(id); }
      for (const id of row.retire ?? []) retired.add(id);
      for (const actor of row.enter ?? []) enter(actor.id, actor.side);
    }
    const black = blackouts.some(r => i >= r.start && i < r.stop), shot = shots.find(r => i >= r.start && i < r.stop) ?? null;
    if (black && !wasBlack && project.blackoutClearsPresence !== false) { hideAll(); present.clear(); }
    if (black || shot) hideAll();
    const desiredBg = black ? project.blackBackground ?? 'black.png' : shot ? '../cg/' + shot.file : bg;
    if (desiredBg !== shownBg) { emit(`changeBg:${desiredBg ?? 'none'} -duration=0 -next;`); shownBg = desiredBg; }
    if (shot !== activeShot) {
      emit(`setVar:_release_news=${shot?.media ? 1 : 0};`);
      if (shot?.title) emit(`unlockCg:../cg/${shot.file} -name=${escapeText(shot.title)} -series=Gallery;`);
      activeShot = shot;
    }
    if (!black && !shot) for (const [id, side] of present) show(id, side);
    wasBlack = black;
    for (const row of music.get(i) ?? []) baseMusic = row;
    const track = musicRanges.find(r => i >= r.start && i < r.stop) ?? baseMusic;
    const trackKey = JSON.stringify([track.file, volume(track.volume)]);
    if (trackKey !== activeMusic) { emit(`bgm:${track.file} -volume=${volume(track.volume)} -enter=1000;`); activeMusic = trackKey; }
    for (const row of sounds.get(i) ?? []) emit(`playEffect:../effect/${row.file} -volume=${volume(row.volume)};`);
    const formatted = beat.lines.map(l => formatLine(l, project.display));
    for (let j = 0; j < formatted.length; j++) if (formatted[j] !== beat.lines[j]) displays.push({ beat: beat.id, line: j + 1, before: beat.lines[j], after: formatted[j] });
    emitted.push(...formatted);
    out.push({ id: beat.id, sourceHash: digest(beat.lines), lines: emitted, state: { background: shownBg, present: [...present], visible: [...visible], retired: [...retired] } });
  }
  const expected = beats.flatMap(b => b.lines.map(l => formatLine(l, project.display))).filter(l => narrative(l));
  const actual = out.flatMap(b => b.lines).filter(l => narrative(l));
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw Error('Presentation lost or duplicated narrative');
  return { beats: out, assets: [...assets].sort(), displayChanges: displays, anchorLock: { version: 1, beats: beats.map(b => ({ id: b.id, hash: digest(b.lines) })) }, narrative: expected };
}
