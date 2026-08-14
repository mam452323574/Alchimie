const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { processUploadedImage } = require('../utils/image-upload');

async function createAnimatedGif() {
  const width = 9;
  const frameHeight = 3;
  const pages = 2;
  const pixels = Buffer.alloc(width * frameHeight * pages * 4);
  const pixelsPerFrame = width * frameHeight;
  for (let index = 0; index < pixelsPerFrame; index += 1) {
    pixels[index * 4] = 255;
    pixels[index * 4 + 3] = 255;
  }
  for (let index = pixelsPerFrame; index < pixelsPerFrame * pages; index += 1) {
    pixels[index * 4 + 1] = 255;
    pixels[index * 4 + 3] = 255;
  }
  return sharp(pixels, {
    raw: { width, height: frameHeight * pages, channels: 4, pageHeight: frameHeight },
  }).gif({ delay: [80, 120], loop: 0 }).toBuffer();
}

test('uploaded raster images are decoded, resized, metadata-stripped and re-encoded as WebP', async () => {
  const source = await sharp({
    create: { width: 5000, height: 12, channels: 3, background: '#4a79b8' },
  }).jpeg().withMetadata({ orientation: 1 }).toBuffer();
  const processed = await processUploadedImage(source);
  const metadata = await sharp(processed.buffer).metadata();

  assert.equal(processed.mime, 'image/webp');
  assert.equal(processed.extension, 'webp');
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 4096);
  assert.equal(metadata.exif, undefined);
  assert.ok(processed.byteSize <= 5 * 1024 * 1024);
});

test('trailing HTML in a polyglot-like image is removed by re-encoding', async () => {
  const image = await sharp({
    create: { width: 4, height: 4, channels: 4, background: '#ffcc00' },
  }).png().toBuffer();
  const marker = Buffer.from('<script>alert(document.domain)</script>');
  const processed = await processUploadedImage(Buffer.concat([image, marker]));

  assert.equal(processed.buffer.includes(marker), false);
  assert.equal((await sharp(processed.buffer).metadata()).format, 'webp');
});

test('animated images keep their frames when safely converted to WebP', async () => {
  const processed = await processUploadedImage(await createAnimatedGif());
  const metadata = await sharp(processed.buffer, { animated: true }).metadata();

  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.pages, 2);
  assert.equal(metadata.pageHeight, 3);
  assert.deepEqual(metadata.delay, [80, 120]);
  assert.equal(processed.pages, 2);
});

test('HTML, SVG and excessive dimensions are rejected before storage', async () => {
  await assert.rejects(
    processUploadedImage(Buffer.from('<html><script>alert(1)</script></html>')),
    (error) => error.code === 'INVALID_IMAGE'
  );
  await assert.rejects(
    processUploadedImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')),
    (error) => ['UNSUPPORTED_IMAGE', 'INVALID_IMAGE'].includes(error.code)
  );
  const tooWide = await sharp({
    create: { width: 12001, height: 1, channels: 3, background: '#000' },
  }).png().toBuffer();
  await assert.rejects(
    processUploadedImage(tooWide),
    (error) => error.code === 'INVALID_DIMENSIONS'
  );
});
