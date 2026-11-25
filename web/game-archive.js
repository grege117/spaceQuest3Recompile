// fflate 0.8.3, distributed under the adjacent MIT license.
import {unzipSync} from "./vendor/fflate/browser.js";

const maxArchiveBytes = 32 * 1024 * 1024;
const maxResourceBytes = 8 * 1024 * 1024;
const tooLarge = "Choose a game ZIP smaller than 32 MB.";

export async function downloadArchive(address) {
  const url = new URL(address);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Enter an HTTP or HTTPS link directly to a ZIP file.");
  if (location.protocol === "https:" && url.protocol === "http:")
    throw new Error("Use an HTTPS link, or download the ZIP and choose it from your device.");
  if (url.origin === "https://archive.org" && url.pathname.startsWith("/download/"))
    url.pathname = url.pathname.replace(/^\/download\//, "/cors/");

  let response;
  try {
    response = await fetch(url, {credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(60000)});
  } catch {
    throw new Error("The ZIP host could not be reached or blocks browser downloads. Download the ZIP and choose it from your device.");
  }
  if (!response.ok) throw new Error(`The ZIP host returned HTTP ${response.status}. Check the link or choose a local ZIP.`);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  if (Number(response.headers.get("Content-Length")) > maxArchiveBytes) {
    await reader.cancel();
    throw new Error(tooLarge);
  }
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxArchiveBytes) {
      await reader.cancel();
      throw new Error(tooLarge);
    }
    chunks.push(value);
  }
  return new Blob(chunks);
}

export async function readGameArchive(blob, config) {
  if (blob.size > maxArchiveBytes) throw new Error(tooLarge);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const wanted = new Set(config.resources);
  const folders = new Map();
  let total = 0;
  let files;
  try {
    files = unzipSync(bytes, {filter(entry) {
      const parts = entry.name.replaceAll("\\", "/").split("/");
      const name = parts.pop().toUpperCase();
      if (!wanted.has(name) || parts.includes("__MACOSX")) return false;
      const directory = parts.join("/").toUpperCase();
      if (!folders.has(directory)) folders.set(directory, new Map());
      const names = folders.get(directory);
      if (names.has(name)) throw new Error("Duplicate game resource " + name);
      total += entry.originalSize;
      if (entry.originalSize > maxResourceBytes || total > maxArchiveBytes)
        throw new Error("Game resources exceed the supported size");
      names.set(name, entry.name);
      return true;
    }});
  } catch (err) {
    throw new Error("Could not open this game ZIP. " + err.message + ".");
  }
  const candidates = [...folders.values()].sort((a, b) => b.size - a.size);
  const folder = candidates[0] ?? new Map();
  const missing = config.resources.filter(name => !folder.has(name));
  if (missing.length) throw new Error("The game folder in this ZIP is missing " + missing.join(", ") + ".");
  if (candidates[1]?.size === folder.size) throw new Error("Choose a ZIP containing one copy of the game.");

  const resources = new Map();
  for (const [name, path] of folder) {
    const data = files[path];
    if (config.resourceHashes[name]) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
      const hex = Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
      if (hex !== config.resourceHashes[name])
        throw new Error(name + " does not match the supported English DOS release. Check the game version and ZIP.");
    }
    resources.set(name, data);
  }
  return resources;
}
