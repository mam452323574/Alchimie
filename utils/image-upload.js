const sharp = require('sharp');

const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'gif', 'webp']);
const MAX_SOURCE_PIXELS = 60_000_000;
const MAX_ANIMATION_PIXELS = 80_000_000;
const MAX_DIMENSION = 12_000;
const MAX_OUTPUT_DIMENSION = 4096;
const MAX_ANIMATION_FRAMES = 120;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

function uploadError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertMetadata(metadata) {
  if (!metadata || !ALLOWED_FORMATS.has(metadata.format)) {
    throw uploadError('UNSUPPORTED_IMAGE', 'Format d’image non pris en charge.');
  }

  const width = Number(metadata.width) || 0;
  const frameHeight = Number(metadata.pageHeight || metadata.height) || 0;
  const pages = Math.max(1, Number(metadata.pages) || 1);
  if (
    width < 1
    || frameHeight < 1
    || width > MAX_DIMENSION
    || frameHeight > MAX_DIMENSION
    || width * frameHeight > MAX_SOURCE_PIXELS
  ) {
    throw uploadError('INVALID_DIMENSIONS', 'Dimensions d’image refusées.');
  }
  if (pages > MAX_ANIMATION_FRAMES || width * frameHeight * pages > MAX_ANIMATION_PIXELS) {
    throw uploadError('ANIMATION_TOO_LARGE', 'Animation trop longue ou trop volumineuse.');
  }
  if (pages > 1 && (width > MAX_OUTPUT_DIMENSION || frameHeight > MAX_OUTPUT_DIMENSION)) {
    throw uploadError('ANIMATION_DIMENSIONS', 'Les animations doivent mesurer au maximum 4096 px de côté.');
  }
  return { width, frameHeight, pages };
}

async function processUploadedImage(source) {
  if (!Buffer.isBuffer(source) || source.length < 12) {
    throw uploadError('INVALID_IMAGE', 'Image illisible.');
  }

  let metadata;
  try {
    metadata = await sharp(source, {
      animated: true,
      failOn: 'error',
      limitInputPixels: MAX_SOURCE_PIXELS,
    }).metadata();
  } catch {
    throw uploadError('INVALID_IMAGE', 'Image illisible ou corrompue.');
  }

  const { width, frameHeight, pages } = assertMetadata(metadata);
  let pipeline = sharp(source, {
    animated: pages > 1,
    failOn: 'error',
    limitInputPixels: MAX_SOURCE_PIXELS,
  }).rotate();

  if (pages === 1 && (width > MAX_OUTPUT_DIMENSION || frameHeight > MAX_OUTPUT_DIMENSION)) {
    pipeline = pipeline.resize({
      width: MAX_OUTPUT_DIMENSION,
      height: MAX_OUTPUT_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  let output;
  try {
    output = await pipeline
      .webp({
        quality: pages > 1 ? 82 : 86,
        alphaQuality: 90,
        effort: pages > 1 ? 3 : 4,
        smartSubsample: true,
      })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw uploadError('INVALID_IMAGE', 'L’image n’a pas pu être décodée de manière sûre.');
  }

  if (!output.data.length || output.data.length > MAX_OUTPUT_BYTES) {
    throw uploadError('OUTPUT_TOO_LARGE', 'L’image optimisée dépasse la limite de 5 Mo.');
  }

  return {
    buffer: output.data,
    mime: 'image/webp',
    extension: 'webp',
    width: output.info.width,
    height: output.info.height,
    pages,
    sourceFormat: metadata.format,
    byteSize: output.data.length,
  };
}

module.exports = {
  ALLOWED_FORMATS,
  MAX_ANIMATION_FRAMES,
  MAX_DIMENSION,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_DIMENSION,
  MAX_SOURCE_PIXELS,
  processUploadedImage,
};
