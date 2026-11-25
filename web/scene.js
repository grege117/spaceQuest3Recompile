import {unzlibSync} from "./vendor/fflate/browser.js";

function paeth(left, above, corner) {
  const p = left + above - corner;
  const a = Math.abs(p - left), b = Math.abs(p - above), c = Math.abs(p - corner);
  if (a <= b && a <= c) return left;
  return b <= c ? above : corner;
}

// The art compilers write non-interlaced, 8-bit RGB backgrounds and RGBA atlases.
// SCI needs the exact stored channel values, before browser display processing.
export function decodeArtPng(bytes, indices) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 33 || view.getUint32(0) !== 0x89504e47 ||
      view.getUint32(4) !== 0x0d0a1a0a || view.getUint32(8) !== 13 ||
      view.getUint32(12) !== 0x49484452) throw new Error("Invalid artwork PNG header");
  const width = view.getUint32(16), height = view.getUint32(20);
  const channels = bytes[25] === 2 ? 3 : 4;
  if (!width || !height || width * height > 16 * 1024 * 1024 ||
      bytes[24] !== 8 || ![2, 6].includes(bytes[25]) || bytes[26] || bytes[27] || bytes[28])
    throw new Error("Unsupported artwork PNG format");

  // Consecutive IDAT chunks comprise a single zlib stream.
  const compressed = new Uint8Array(bytes.length);
  let length = 0;
  for (let pos = 33; pos + 12 <= bytes.length;) {
    const size = view.getUint32(pos), type = view.getUint32(pos + 4);
    if (pos + 12 + size > bytes.length) throw new Error("Incomplete artwork PNG chunk");
    if (type === 0x49444154) {
      compressed.set(bytes.subarray(pos + 8, pos + 8 + size), length);
      length += size;
    }
    pos += size + 12;
    if (type === 0x49454e44) break;
  }
  const stride = 1 + width * channels;
  const scan = unzlibSync(compressed.subarray(0, length), {out: new Uint8Array(height * stride)});
  if (scan.length !== height * stride) throw new Error("Incomplete artwork PNG scanlines");
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride, filter = scan[row];
    if (filter > 4) throw new Error("Unknown artwork PNG row filter");
    for (let i = row + 1; filter && i < row + stride; i++) {
      const left = i > row + channels ? scan[i - channels] : 0;
      const above = y ? scan[i - stride] : 0;
      if (filter === 1) scan[i] += left;
      else if (filter === 2) scan[i] += above;
      else if (filter === 3) scan[i] += (left + above) >> 1;
      else scan[i] += paeth(left, above, y && i > row + channels ? scan[i - stride - channels] : 0);
    }
    for (let x = 0, i = row + 1; x < width; x++, i += channels) {
      if (channels === 4 && scan[i + 3] === 0) continue;
      const color = (scan[i] << 16) | (scan[i + 1] << 8) | scan[i + 2];
      const index = indices.get(color);
      if (index === undefined) throw new Error("Unlisted artwork palette color");
      pixels[y * width + x] = index;
    }
  }
  return {width, height, pixels};
}

// The VM supplies a composited frame with three 4-bit EGA indices per pixel.
export const ega = [
  0x000000, 0x0000aa, 0x00aa00, 0x00aaaa, 0xaa0000, 0xaa00aa, 0xaa5500, 0xaaaaaa,
  0x555555, 0x5555ff, 0x55ff55, 0x55ffff, 0xff5555, 0xff55ff, 0xffff55, 0xffffff
];

export function encodePlane(width, height, data, plane) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; ++i) {
    const index = data[3 * i + plane] & 15;
    const rgb = plane === 0 ? ega[index] : index * 0x111111;
    image.data.set([rgb >> 16, (rgb >> 8) & 255, rgb & 255, 255], 4 * i);
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

// Search the full visual plane for an authored native-resolution pixel pattern.
// The room selects the template family. It supplies no predicted coordinates.
export function locateTemplate(data, width, height, template) {
  const rows = template.rows.map(row => Array.from(row, hex => parseInt(hex, 16)));
  const w = rows[0].length, h = rows.length;
  const maxErrors = Math.floor(w * h * (1 - template.minAgreement));
  let bestErrors = maxErrors + 1;
  let found;
  for (let y = 0; y <= height - h; y++) {
    for (let x = 0; x <= width - w; x++) {
      let errors = 0;
      for (let dy = 0; dy < h && errors < bestErrors; dy++) {
        const start = 3 * ((y + dy) * width + x);
        for (let dx = 0; dx < w && errors < bestErrors; dx++) {
          if (data[start + 3 * dx] !== rows[dy][dx]) errors++;
        }
      }
      if (errors < bestErrors) {
        bestErrors = errors;
        found = {name: template.name, bounds: [x, y, x + w, y + h], agreement: 1 - errors / (w * h)};
        if (errors === 0) return found;
      }
    }
  }
  return found;
}

export function finishFrame(frame, width, height, data, templates) {
  const templateMatches = templates.map(t => locateTemplate(data, width, height, t)).filter(Boolean);
  const planes = {};
  for (const [i, name] of ["visual", "priority", "control"].entries()) {
    planes[name] = encodePlane(width, height, data, i);
  }
  return {...frame, width, height, templateMatches, planes};
}
