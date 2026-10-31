// Keep the live screenshot at its original coordinates; historical choices go below it.
// Accepts one scan or a list of scans; several scans get one row each, in order.
function choiceSheet(screen, choices, nativeImage = require('electron').nativeImage) {
  const live = nativeImage.createFromDataURL(screen.imageDataUrl);
  const { width, height } = live.getSize();
  const groups = Array.isArray(choices) ? choices : [choices], gap = 8;
  const columns = groups.length === 1 ? Math.min(4, groups[0].images.length) : Math.max(...groups.map(g => g.images.length));
  const cellWidth = Math.min(400, Math.floor(width / columns) - gap);
  const tiles = [];
  let top = height + gap;
  for (const group of groups) {
    const cellHeight = Math.min(groups.length === 1 ? 320 : 240, Math.round(cellWidth * group.region.height / group.region.width));
    group.images.forEach((data, index) => {
      if (index && index % columns === 0) top += cellHeight + gap;
      tiles.push({ image: nativeImage.createFromDataURL(data).crop(group.region).resize({ width: cellWidth, height: cellHeight }),
        x: index % columns * (cellWidth + gap), y: top });
    });
    top += cellHeight + gap;
  }
  const totalHeight = top;
  if (width * totalHeight > 5e7) throw new Error('Choice sheet is too large. Use a smaller scan.');
  const bitmap = Buffer.alloc(width * totalHeight * 4, 255);
  function paste(image, x, y) {
    const size = image.getSize(), pixels = image.toBitmap({ scaleFactor: 1 });
    for (let row = 0; row < size.height; row++) {
      pixels.copy(bitmap, ((y + row) * width + x) * 4, row * size.width * 4, (row + 1) * size.width * 4);
    }
  }
  paste(live, 0, 0);
  tiles.forEach(tile => paste(tile.image, tile.x, tile.y));
  return nativeImage.createFromBitmap(bitmap, { width, height: totalHeight, scaleFactor: 1 }).toDataURL();
}
module.exports = { choiceSheet };
