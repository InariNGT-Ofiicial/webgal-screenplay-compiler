// Native WebGAL script helpers. Escape-aware splitting is shared by build and QA.
export function splitUnescaped(text, delimiter) {
  const parts = []; let start = 0, slashes = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === delimiter && slashes % 2 === 0) { parts.push(text.slice(start, i)); start = i + 1; }
    slashes = text[i] === '\\' ? slashes + 1 : 0;
  }
  parts.push(text.slice(start)); return parts;
}
export function statement(line) { return splitUnescaped(line.trim(), ';')[0]; }
export function escapeText(text) {
  return String(text ?? '').replace(/\\/g, '\\\\').replace(/[{}:|;]/g, c => '\\' + c);
}
export function narrative(line) {
  const s = statement(line);
  if (!s.startsWith('say:') && !s.startsWith(':')) return null;
  const offset = s.startsWith('say:') ? 4 : 1;
  const suffix = s.slice(offset).search(/ -(?:speaker|figureId|vocal|fontSize|volume|notend|concat|next|center|left|right)(?:=|\s|$)/);
  const end = suffix < 0 ? s.length : offset + suffix;
  return { text: s.slice(offset, end), prefix: s.slice(0, offset), suffix: line.trim().slice(end) };
}
export function references(lines) {
  const labels = [], jumps = [], scenes = [];
  for (const line of lines) {
    const s = statement(line);
    if (s.startsWith('label:')) labels.push(s.slice(6).trim());
    if (s.startsWith('jumpLabel:')) jumps.push(s.slice(10).split(' -')[0].trim());
    if (s.startsWith('choose:')) for (const option of splitUnescaped(s.slice(7), '|')) {
      const target = splitUnescaped(option, ':').at(-1).split(' -')[0].trim();
      if (target.endsWith('.txt')) scenes.push(target); else jumps.push(target);
    }
    if (s.startsWith('changeScene:')) scenes.push(s.slice(12).split(' -')[0].trim());
  }
  return { labels, jumps, scenes };
}
export function validateScenes(scenes) {
  const errors = [];
  for (const [name, lines] of Object.entries(scenes)) {
    const refs = references(lines), counts = new Map();
    for (const label of refs.labels) counts.set(label, (counts.get(label) || 0) + 1);
    for (const [label, count] of counts) if (count !== 1) errors.push(`${name}: duplicate label ${label}`);
    for (const target of refs.jumps) if (counts.get(target) !== 1) errors.push(`${name}: unresolved local target ${target}`);
    for (const target of refs.scenes) if (!Object.hasOwn(scenes, target)) errors.push(`${name}: missing scene ${target}`);
  }
  if (errors.length) throw Error(errors.join('\n'));
}
