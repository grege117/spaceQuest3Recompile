import {decodeArtPng, ega, encodePlane} from "./scene.js";

// Emscripten calls these methods while the SCI picture and cel data are live.
const params = new URLSearchParams(location.search);
const packs = new Map();
let rooms = {};
const failed = new Set();
let reportError;
let sharedCels;
let currentPack;
let picture;
const sources = new Map();

function base64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}

export const artwork = {
  original: params.get("art") === "original" || params.has("exportArt"),
  packActive: false,
  get active() { return this.packActive && !this.original; },
  exportSources: params.has("exportArt"),
  exportViewCount(id) {
    const target = params.get("exportArt");
    if (!rooms[id] || (this.exportSources && target !== "all" && target !== String(id))) return -1;
    this.exportViews = rooms[id].artworkViews ?? [];
    return this.exportViews.length;
  },
  sourcePicture(id, x, y, width, height, bytes) {
    picture = {id, x, y, width, height, planes: base64(bytes)};
    sources.clear();
  },
  sourceCel(view, loop, cel, width, height, dx, dy, clear, bytes) {
    sources.set([view, loop, cel].join("/"), {view, loop, cel, width, height, dx, dy, clear, pixels: base64(bytes)});
  },
  hasSource(id) {
    return picture?.id === id && this.currentPicture === id;
  },
  sourceData() {
    if (!picture) throw new Error("Enter the room selected for source export first.");
    return {picture, cels: [...sources.values()]};
  },
  captureDisplay(width, height, indices, palette) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(width, height);
    for (let i = 0; i < indices.length; i++) {
      const offset = 3 * indices[i];
      image.data[4*i] = palette[offset];
      image.data[4*i+1] = palette[offset+1];
      image.data[4*i+2] = palette[offset+2];
      image.data[4*i+3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    this.renderedFrame = canvas.toDataURL("image/png");
  },
  needsPack(id) {
    return !!rooms[id]?.artwork && rooms[id].kind !== "overlay" &&
      !this.exportSources && !packs.has(id) && !failed.has(id);
  },
  async prepare(id) {
    try {
      await loadPack(id, rooms[id].artwork);
      if (packs.size > 6) packs.delete(packs.keys().next().value);
    } catch (error) {
      failed.add(id);
      reportError(rooms[id].name + " will use original graphics. " + error.message);
    }
  },
  select(id, width, height) {
    this.currentPicture = id;
    currentPack = packs.get(id);
    this.packActive = !!currentPack && width === currentPack.width && height === currentPack.height;
    this.background = currentPack?.background;
    this.colors = currentPack?.colors;
    return this.packActive;
  },
  cel(view, loop, cel, width, height) {
    const entry = currentPack?.cels.get([view, loop, cel].join("/"));
    return entry?.width === width && entry.height === height ? entry.pixels : null;
  }
};
window.sq3Artwork = artwork;

async function loadIndices(url, indices) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("HTTP " + response.status);
    return decodeArtPng(new Uint8Array(await response.arrayBuffer()), indices);
  } catch (error) {
    throw new Error(error.message + " in " + url);
  }
}

function decodeCels(entries, atlas) {
  const cels = new Map();
  for (const {view, loop, cel, x, y, width, height} of entries) {
    if (x < 0 || y < 0 || x + width > atlas.width || y + height > atlas.height)
      throw new Error("Sprite bounds exceed the atlas");
    const pixels = new Uint8Array(width * height);
    for (let row = 0; row < height; row++) {
      const pos = (y + row) * atlas.width + x;
      pixels.set(atlas.pixels.subarray(pos, pos + width), row * width);
    }
    cels.set([view, loop, cel].join("/"), {width, height, pixels});
  }
  return cels;
}

async function sharedSprites(manifest, url) {
  if (sharedCels) return sharedCels;
  const [atlas, response] = await Promise.all([
    loadIndices(new URL(manifest.atlas, url), new Map(manifest.palette.slice(191).map(
      ([r,g,b], i) => [(r << 16) | (g << 8) | b, 207 + i]))),
    fetch(new URL(manifest.sharedCels, url))
  ]);
  if (!response.ok) throw new Error("Missing shared cel metadata");
  sharedCels = decodeCels(await response.json(), atlas);
  return sharedCels;
}

async function loadPack(id, path) {
  if (!path || artwork.exportSources) return;
  const url = new URL(path, document.baseURI);
  const response = await fetch(url);
  if (!response.ok) throw new Error("Missing artwork manifest");
  const manifest = await response.json();
  const colors = Uint8Array.from(manifest.palette.flat());
  if (colors.length !== 239 * 3) throw new Error("Expected 239 artwork palette entries");
  const indices = new Map(manifest.palette.map(([r,g,b], i) => [(r << 16) | (g << 8) | b, i + 16]));
  if (manifest.picture !== id) throw new Error("Artwork manifest has the wrong picture ID");
  const [background, cels] = await Promise.all([
    manifest.background ? loadIndices(new URL(manifest.background, url), indices) :
      {width: manifest.width, height: manifest.height, pixels: new Uint8Array(manifest.width * manifest.height)},
    manifest.sharedCels ? sharedSprites(manifest, url) :
      loadIndices(new URL(manifest.atlas, url), indices).then(atlas => decodeCels(manifest.cels, atlas))
  ]);
  if (background.width !== manifest.width || background.height !== manifest.height)
    throw new Error("Background dimensions differ from the manifest");
  packs.set(id, {width: manifest.width, height: manifest.height, colors, background: background.pixels, cels});
}

export async function loadArtwork(configuredRooms, onError) {
  rooms = configuredRooms;
  reportError = onError;
  const selector = document.querySelector("#art-room");
  for (const [id, room] of Object.entries(rooms)) {
    if (room.artwork && room.kind !== "overlay") selector.add(new Option(room.name + " · " + id, id));
  }
  document.querySelector("#inspect-art").disabled = !selector.options.length;
}

const captions = {
  "background.png": "The room background on its native 320 × 190 picture grid.",
  "source/background.png": "The original SCI picture before any sprites are drawn. The picture begins at screen row 10, below the score bar.",
  "source/priority.png": "Brighter pixels have higher drawing priority. An actor is visible where its priority equals or exceeds the room’s priority.",
  "source/control.png": "Each shade represents one of 16 script-defined regions. The game uses these regions for movement and interaction.",
  "sprites.png": "Recolored animation cels. Transparency, frame dimensions and displacement come from the original resources.",
  "source/sprites.png": "Decoded cels for Roger and the views used by this room. Cel metadata identifies each frame by view, loop and cel."
};

function assetUrl(id, name) {
  return new URL(name, new URL(rooms[id].artwork, document.baseURI)).href;
}

async function castPreview(id) {
  let objects, url, caption;
  if (artwork.currentPicture === id) {
    const frame = await window.sq3.captureScene();
    if (artwork.currentPicture !== id) throw new Error("The scene changed during capture.");
    objects = frame.objects;
    url = frame.planes.rendered;
    caption = "Current frame";
  } else {
    if (!rooms[id].castSample) throw new Error("Enter this picture in the game to inspect its live actors and priorities.");
    const response = await fetch(assetUrl(id, "source/cast.json"));
    if (!response.ok) throw new Error("Missing sample cast");
    objects = (await response.json()).objects;
    url = assetUrl(id, "preview.png");
    caption = rooms[id].name + " sample frame";
  }
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width * 2;
  canvas.height = image.height * 2;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  ctx.font = "12px monospace";
  ctx.lineWidth = 2;
  for (const obj of objects) {
    const [x, y, right, bottom] = obj.bounds.map(i => 2 * i);
    ctx.strokeStyle = "#ffd184";
    ctx.strokeRect(x, y, right-x, bottom-y);
    const label = obj.name + " · " + obj.priority;
    const labelY = Math.max(14, y);
    ctx.fillStyle = "#18211d";
    ctx.fillRect(x, labelY-15, ctx.measureText(label).width+8, 15);
    ctx.fillStyle = "#ffd184";
    ctx.fillText(label, x+4, labelY-4);
  }
  return {url: canvas.toDataURL("image/png"), caption: caption + ". Each box shows the actor’s SCI name and drawing priority."};
}

// Recreate source previews from the player's mounted resources.
function sourcePreview(id, layer) {
  if (!artwork.hasSource(id)) throw new Error("Enter this room to inspect its original artwork from your game ZIP.");
  if (layer !== "source/sprites.png") {
    const channel = ["source/background.png", "source/priority.png", "source/control.png"].indexOf(layer);
    const planes = Uint8Array.from(atob(picture.planes), c => c.charCodeAt(0));
    return encodePlane(picture.width, picture.height, planes, channel);
  }
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  let x = 1, y = 1, row = 0;
  const cells = [];
  for (const cel of sources.values()) {
    if (x + cel.width + 1 > canvas.width) { x = 1; y += row + 2; row = 0; }
    cells.push({cel, x, y});
    x += cel.width + 2;
    row = Math.max(row, cel.height);
  }
  canvas.height = y + row + 1;
  const ctx = canvas.getContext("2d");
  for (const {cel, x, y} of cells) {
    const pixels = atob(cel.pixels);
    const image = ctx.createImageData(cel.width, cel.height);
    for (let i = 0; i < pixels.length; i++) {
      const index = pixels.charCodeAt(i);
      const rgb = ega[index & 15];
      image.data.set([rgb >> 16, (rgb >> 8) & 255, rgb & 255, index === cel.clear ? 0 : 255], 4 * i);
    }
    ctx.putImageData(image, x, y);
  }
  return canvas.toDataURL("image/png");
}

let previewRequest = 0;
async function previewLayer() {
  const request = ++previewRequest;
  const layer = document.querySelector("#art-layer");
  const preview = document.querySelector("#art-preview");
  const caption = document.querySelector("#art-caption");
  const download = document.querySelector("#art-download");
  try {
    const id = Number(document.querySelector("#art-room").value);
    document.querySelector("#cel-metadata").href = assetUrl(id, "source/resources.json");
    const sprites = layer.querySelector('option[value="sprites.png"]');
    sprites.disabled = !rooms[id].artworkViews?.length;
    if (sprites.disabled && layer.value === "sprites.png") layer.value = "background.png";
    const cast = layer.querySelector('option[value="cast"]');
    cast.disabled = !rooms[id].castSample && artwork.currentPicture !== id;
    if (cast.disabled && layer.value === "cast") layer.value = "background.png";
    let url = layer.value.startsWith("source/") ? sourcePreview(id, layer.value) : assetUrl(id, layer.value);
    if (layer.value === "background.png" && [121, 161, 777].includes(id)) {
      const blank = document.createElement("canvas");
      blank.width = 320;
      blank.height = 190;
      blank.getContext("2d").fillRect(0, 0, 320, 190);
      url = blank.toDataURL("image/png");
    }
    const result = layer.value === "cast" ? await castPreview(id) :
      {url, caption: rooms[id].kind === "overlay" && layer.value === "background.png" ? "This SCI overlay is composited over the active picture during play." : captions[layer.value]};
    if (request !== previewRequest) return;
    preview.src = result.url;
    preview.alt = layer.selectedOptions[0].textContent;
    caption.textContent = result.caption;
    download.href = result.url;
    download.download = rooms[id].name.toLowerCase().replaceAll(" ", "-") + "-" + layer.value.replaceAll("/", "-").replace(/\.png$/, "") + ".png";
  } catch (error) {
    if (request !== previewRequest) return;
    preview.removeAttribute("src");
    caption.textContent = error.message;
    download.removeAttribute("href");
  }
}

document.querySelector("#inspect-art").addEventListener("click", () => {
  if (rooms[artwork.currentPicture]?.artwork && rooms[artwork.currentPicture].kind !== "overlay") document.querySelector("#art-room").value = artwork.currentPicture;
  previewLayer();
  document.querySelector("#art-dialog").showModal();
});
document.querySelector("#art-room").addEventListener("change", previewLayer);
document.querySelector("#art-layer").addEventListener("change", previewLayer);
if (params.get("art") === "original") {
  const alternate = document.querySelector("#other-edition");
  alternate.href = location.pathname;
  alternate.textContent = "Play with enhanced art ↗";
}
