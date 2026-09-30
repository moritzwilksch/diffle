/** Leading bytes of the raster formats browsers display; `null` matches any byte. */
const SIGNATURES: [type: string, magic: (number | null)[]][] = [
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/gif', ascii('GIF8')],
  ['image/webp', [...ascii('RIFF'), null, null, null, null, ...ascii('WEBP')]],
  ['image/avif', [null, null, null, null, ...ascii('ftypavif')]],
  ['image/avif', [null, null, null, null, ...ascii('ftypavis')]],
  ['image/bmp', ascii('BM')],
  ['image/x-icon', [0x00, 0x00, 0x01, 0x00]],
];

function ascii(s: string): number[] {
  return [...s].map((ch) => ch.charCodeAt(0));
}

/**
 * The media type of a raster image, read from its leading bytes; null for anything else. The
 * extension is not consulted: only bytes that are an image get served as one.
 */
export function imageType(buf: Buffer): string | null {
  for (const [type, magic] of SIGNATURES) {
    if (buf.length >= magic.length && magic.every((b, i) => b == null || buf[i] === b)) return type;
  }
  return null;
}
