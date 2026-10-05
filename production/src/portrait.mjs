// Extracted from the Codex production framing formula. One uniform scale per image.
export function figureTransform(profile, side, options = {}) {
  const { height, top = 0, facing = 1, displayPixelScale } = profile ?? {};
  if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(top) || top < 0 || top >= height || ![1, -1].includes(facing) || !Number.isFinite(displayPixelScale) || displayPixelScale <= 0) throw Error('Invalid measured portrait profile');
  if (!['left', 'right'].includes(side)) throw Error('Portrait side must be left or right');
  const { stageHeight = 1440, lateral = 740, vertical = 200 } = options;
  if (![stageHeight, lateral, vertical].every(Number.isFinite) || stageHeight <= 0 || lateral < 0) throw Error('Invalid stage framing');
  const scale = displayPixelScale * height / stageHeight;
  return { position: { x: side === 'left' ? -lateral : lateral, y: Math.round(vertical + stageHeight / 2 * (scale - 1) - top * displayPixelScale) }, scale: { x: scale * (side === 'left' ? 1 : -1) / facing, y: scale }, alpha: 1 };
}
