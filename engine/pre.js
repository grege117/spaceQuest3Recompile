// SCI0 strings in this DOS release use code page 437.
function sq3DosText(ptr) {
  const high = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
  let text = "";
  for (let byte; (byte = HEAPU8[ptr++]);) {
    text += byte < 128 ? String.fromCharCode(byte) : high[byte - 128];
  }
  return text;
}

// This runs inside Emscripten's module scope, before main().
Module.preRun = [function () {
  const bridge = window.sq3;
  ENV.SDL_EMSCRIPTEN_KEYBOARD_ELEMENT = "#canvas";
  FS.mkdir("/sq3");
  FS.mkdir("/saves");
  for (const [name, bytes] of bridge.files) FS.writeFile("/sq3/" + name, bytes);
  bridge.files.clear();

  // The game's original save and restore commands use this mounted directory.
  FS.mount(IDBFS, {}, "/saves");
  addRunDependency("saved-games");
  FS.syncfs(true, function (error) {
    if (error) bridge.notice("Browser storage is unavailable. Saves will last for this session.");
    else {
      let syncing = false;
      const flush = function () {
        if (syncing) return;
        syncing = true;
        FS.syncfs(false, function (err) {
          syncing = false;
          if (err) bridge.notice("Could not write saved games to browser storage.");
        });
      };
      setInterval(flush, 1200);
      document.addEventListener("visibilitychange", flush);
    }
    removeRunDependency("saved-games");
  });
}];
