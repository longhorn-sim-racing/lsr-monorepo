/**
 * An image's type and pixel size from its first bytes (JPEG's frame header, PNG's IHDR), for the fakes:
 * Cloudinary's reports width and height, and Instagram's checks a JPEG's aspect ratio as the real one
 * does. No image library, so the fakes stay light.
 */

export type ImageInfo = { format: "jpg" | "png"; width: number; height: number }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length > 24 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { format: "png", width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (!isJpeg(bytes)) return null
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++
      continue
    }
    const marker = bytes[i + 1]
    // Markers without a length: padding, start of image, restarts
    if (marker === 0xff || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += marker === 0xff ? 1 : 2
      continue
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3]
    // Start of frame (baseline, progressive, …): not DHT (c4), JPG (c8) or DAC (cc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { format: "jpg", height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] }
    }
    i += 2 + length
  }
  return null
}
