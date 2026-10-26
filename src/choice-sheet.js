// Keep the live screenshot at its original coordinates; historical choices go below it.
function choiceSheet(screen, choices, nativeImage = require('electron').nativeImage) {
  const live = nativeImage.createFromDataURL(screen.imageDataUrl);
  const { width, height } = live.getSize();
  const columns = Math.min(4, choices.images.length), gap = 8;
  const cellWidth = Math.min(400, Math.floor(width / columns) - gap);
  const cellHeight = Math.min(320, Math.round(cellWidth * choices.region.height / choices.region.width));
  const tiles = choices.images.map(data => nativeImage.createFromDataURL(data).crop(choices.region)
    .resize({ width: cellWidth, height: cellHeight }));
  const totalHeight = height + gap + Math.ceil(tiles.length / columns) * (cellHeight + gap);
  if (width * totalHeight > 5e7) throw new Error('Choice sheet is too large. Use a smaller scan.');
  const bitmap = Buffer.alloc(width * totalHeight * 4, 255);
  function paste(image, x, y) {
    const size = image.getSize(), pixels = image.toBitmap({ scaleFactor: 1 });
    for (let row = 0; row < size.height; row++) {
      pixels.copy(bitmap, ((y + row) * width + x) * 4, row * size.width * 4, (row + 1) * size.width * 4);
    }
  }
  paste(live, 0, 0);
  tiles.forEach((tile, index) => paste(tile, index % columns * (cellWidth + gap),
    height + gap + Math.floor(index / columns) * (cellHeight + gap)));
  return nativeImage.createFromBitmap(bitmap, { width, height: totalHeight, scaleFactor: 1 }).toDataURL();
}
module.exports = { choiceSheet };
