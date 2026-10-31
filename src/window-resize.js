function resizeBounds(initial, corner, deltaX, deltaY) {
  if (!['bottom-left', 'bottom-right'].includes(corner) || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) throw new Error('Invalid resize');
  const left = corner === 'bottom-left';
  const width = Math.round(Math.max(520, Math.min(2000, initial.width + (left ? -deltaX : deltaX))));
  const height = Math.round(Math.max(300, Math.min(1600, initial.height + deltaY)));
  return { x: left ? initial.x + initial.width - width : initial.x, y: initial.y, width, height };
}
module.exports = { resizeBounds };
