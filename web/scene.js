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
