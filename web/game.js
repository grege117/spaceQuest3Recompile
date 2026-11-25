import {loadArtwork, artwork} from "./artwork.js";
import {downloadArchive, readGameArchive} from "./game-archive.js";
import {finishFrame} from "./scene.js";

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const input = $("command");
const send = document.querySelector(".send");
const log = $("log");
let config;
let walkRooms = [];
let room = null;
let ready = false;
let sceneState = {};
let pending = null;
let hintIndex = 0;
let lastDialog = "";
let stopped = false;
let capture;
let frame;

function message(speaker, text, kind = "") {
  if (!text) return;
  const follow = log.scrollHeight - log.clientHeight - log.scrollTop < 48 || kind === "out";
  const item = document.createElement("div");
  item.className = "message " + kind;
  const label = document.createElement("small");
  label.textContent = speaker;
  const body = document.createElement("p");
  body.textContent = text;
  item.append(label, body);
  log.append(item);
  if (follow) log.scrollTop = log.scrollHeight;
}

function gameText(text) {
  return text.replace(/\r\n?/g, "\n").replace(/_+/g, " ").trim();
}

function scene() {
  return config.rooms[room];
}

function updateStatus() {
  $("location").textContent = scene()?.name ?? "Room " + room;
  $("guidance").textContent = scene()?.intro
    ? (room === 777 ? "Starting the game…" : "Click the scene to skip the opening.")
    : ready ? "Click to walk · Arrow keys to move · [ ] to switch rooms" : "Follow the action on the game screen.";
  input.disabled = stopped;
  send.disabled = stopped || !!pending;
}

function updateGraphicsButton() {
  const button = $("graphics-mode");
  button.hidden = room === null || stopped || artwork.exportSources;
  button.textContent = artwork.original ? "Original graphics" : "Enhanced graphics";
  button.title = "Switch to " + (artwork.original ? "enhanced" : "original") + " graphics (backtick)";
  button.setAttribute("aria-label", button.title);
}

function toggleGraphics() {
  artwork.original = !artwork.original;
  updateGraphicsButton();
}

function cancelCommand() {
  if (!pending) return;
  clearTimeout(pending.timeout);
  pending = null;
  message("Console", "The scene changed before Roger could act. Send the command again when ready.");
  updateStatus();
}

window.sq3 = {
  files: new Map(),
  walkDestination(current, direction) {
    if (!walkRooms.length || config.rooms[current]?.intro) return 0;
    if (direction > 0) return walkRooms.find(id => id > current) ?? walkRooms[0];
    for (let i = walkRooms.length - 1; i >= 0; i--) {
      if (walkRooms[i] < current) return walkRooms[i];
    }
    return walkRooms[walkRooms.length - 1];
  },
  takeWalkArrival(id, initialized = false) {
    const entry = this.walkArrival === id ? config.rooms[id]?.walkEntry : null;
    if (initialized || !entry?.placeAfterInit) this.walkArrival = null;
    return entry;
  },
  poll(id, acceptsInput, motivatorHere) {
    if (stopped) return 0;
    const changedRoom = room !== id;
    const canSend = acceptsInput && !config.rooms[id]?.intro;
    if (sceneState.motivatorHere !== motivatorHere) hintIndex = 0;
    sceneState = {motivatorHere};
    if (changedRoom || ready !== canSend) {
      if (changedRoom) {
        hintIndex = 0;
        lastDialog = "";
      }
      room = id;
      if (changedRoom) updateGraphicsButton();
      ready = canSend;
      if (pending && (changedRoom || !canSend)) cancelCommand();
      $("loading").hidden = true;
      updateStatus();
    }
    if (pending && ready && !pending.dispatched) {
      pending.dispatched = true;
      return pending.text.charCodeAt(0);
    }
    return 0;
  },
  takeCommand() {
    if (!pending?.dispatched) return "";
    const text = pending.text;
    clearTimeout(pending.timeout);
    pending = null;
    updateStatus();
    return text;
  },
  speech(text) {
    lastDialog = "";
    message("Space Quest", gameText(text));
  },
  dialog(text) {
    // SCI can redraw a native dialog several times during one interaction.
    if (text !== lastDialog && text !== "Enter input") message("Space Quest", gameText(text));
    lastDialog = text;
  },
  notice(text) { message("Console", text); },
  // Developer entry point. Bounds are [left, top, right, bottom) in SCI pixels.
  captureScene() {
    if (capture) return capture.promise;
    if (stopped || room === null) return Promise.reject(new Error("Game is not running."));
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    const timer = setTimeout(() => {
      capture = null;
      this.captureRequested = false;
      reject(new Error("No animated frame arrived. Close any open game dialog and retry."));
    }, 4000);
    capture = {promise, resolve, reject, timer};
    this.captureRequested = true;
    return promise;
  },
  beginFrame(id) { frame = {room: id, width: 320, height: 200, objects: []}; },
  addObject(name, view, loop, cel, priority, left, top, right, bottom) {
    frame.objects.push({name, view, loop, cel, priority, bounds: [left, top, right, bottom]});
  },
  endFrame(width, height, pixels) {
    clearTimeout(capture.timer);
    this.captureRequested = false;
    try {
      const result = finishFrame(frame, width, height, pixels, config.rooms[frame.room]?.templates ?? []);
      if (artwork.renderedFrame) result.planes.rendered = artwork.renderedFrame;
      result.picture = artwork.currentPicture;
      if (artwork.hasSource(result.picture)) result.sourceArt = artwork.sourceData();
      capture.resolve(result);
    } catch (err) {
      capture.reject(err);
    }
    capture = null;
  }
};

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || pending || stopped || room === null) return;
  input.value = "";
  message("Roger", text, "out");
  if (text.toLowerCase() === config.hintCommand.toLowerCase()) {
    const variant = scene()?.variants?.find(({when}) =>
      Object.entries(when).every(([key, value]) => sceneState[key] === value));
    const hints = variant?.hints ?? scene()?.hints ?? config.defaultHints;
    message("Hint", hints[Math.min(hintIndex++, hints.length - 1)], "hint");
  } else if (!ready) {
    message("Console", $("guidance").textContent);
  } else if (!/^[\x20-\x7e]{1,45}$/.test(text)) {
    message("Console", "The DOS parser accepts up to 45 printable ASCII characters.");
  } else {
    lastDialog = "";
    pending = {text, dispatched: false, timeout: setTimeout(cancelCommand, 2000)};
    updateStatus();
  }
  input.focus();
});

$("graphics-mode").addEventListener("click", () => {
  toggleGraphics();
  canvas.focus();
});

// Consume the shortcut before SDL can send it to the DOS parser.
function handleGraphicsKey(event) {
  if (event.key !== "`" || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey ||
      event.isComposing || $("graphics-mode").hidden) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.type === "keydown" && !event.repeat) toggleGraphics();
}
canvas.addEventListener("keydown", handleGraphicsKey, true);
canvas.addEventListener("keyup", handleGraphicsKey, true);
canvas.addEventListener("pointerdown", () => canvas.focus());
$("expand").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.querySelector(".display").requestFullscreen();
    canvas.focus();
  } catch { message("Console", "Fullscreen is unavailable in this browser."); }
});

$("capture").addEventListener("click", async () => {
  const button = $("capture");
  button.disabled = true;
  try {
    const snapshot = await window.sq3.captureScene();
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {type: "application/json"});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "sq3-room-" + snapshot.room + ".json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) {
    message("Console", String(error.message));
  } finally {
    button.disabled = false;
  }
});

function fail(reason) {
  if (stopped) return;
  stopped = true;
  updateGraphicsButton();
  if (pending) clearTimeout(pending.timeout);
  pending = null;
  input.disabled = send.disabled = true;
  $("game-import").hidden = true;
  $("location").textContent = "Offline";
  $("loading").hidden = false;
  $("loading").textContent = "Game stopped";
  $("guidance").textContent = "Reload the page to retry.";
  message("Console", String(reason));
}

async function getFile(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not load " + url + " (HTTP " + response.status + ").");
  return response;
}

async function boot() {
  config = await (await getFile("config/game.json")).json();
  walkRooms = Object.entries(config.rooms)
    .filter(([, room]) => room.walkEntry)
    .map(([id]) => Number(id))
    .sort((a, b) => a - b);
  setImportBusy(false);
}

function setImportBusy(busy) {
  for (const id of ["game-file", "zip-url", "zip-load"]) $(id).disabled = busy;
}

async function importGame(file, url) {
  if ($("zip-load").disabled) return;
  setImportBusy(true);
  const status = $("import-status");
  try {
    status.textContent = file ? "Reading ZIP…" : "Downloading ZIP…";
    const archive = file ?? await downloadArchive(url);
    status.textContent = "Checking game files…";
    window.sq3.files = await readGameArchive(archive, config);
  } catch (error) {
    status.textContent = error.message;
    setImportBusy(false);
    return;
  }
  $("game-import").hidden = true;
  $("loading").hidden = false;
  $("location").textContent = "Starting game";
  $("guidance").textContent = "Loading the SCI interpreter…";
  canvas.focus();
  await startGame();
}

$("game-file").addEventListener("change", event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (file) importGame(file).catch(fail);
});
$("zip-form").addEventListener("submit", event => {
  event.preventDefault();
  importGame(null, $("zip-url").value.trim()).catch(fail);
});

async function startGame() {
  try {
    const pictures = await (await getFile("config/pictures.json")).json();
    for (const [id, room] of Object.entries(config.rooms)) {
      if (room.artwork) pictures[id] = {...pictures[id], artwork: room.artwork, artworkViews: room.artworkViews};
    }
    await loadArtwork(pictures, text => message("Console", text));
  } catch (error) {
    message("Console", "Using original graphics. " + error.message);
  }
  window.Module = {
    canvas,
    arguments: ["--path=/sq3", "--savepath=/saves", "--aspect-ratio",
      "--music-driver=" + config.musicDriver, config.target],
    onAbort: fail,
    onExit: () => fail("The game has ended."),
    printErr: (line) => console.warn(line)
  };
  const script = document.createElement("script");
  script.src = "web/runtime/scummvm.js";
  script.onerror = () => fail("Could not load the WebAssembly runtime. Build it with engine/build.sh.");
  document.head.append(script);
  message("Console", "Send a command to Roger, or type hint for a clue about the current scene.");
}
boot().catch(fail);
