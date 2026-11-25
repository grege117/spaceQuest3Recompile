#!/usr/bin/env bash
# Rebuild the SCI runtime from ScummVM 2.9.0 and Emscripten 3.1.51.
set -eo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
build_dir=${BUILD_DIR:-"$root/.build"}
mkdir -p "$build_dir"
build_dir=$(cd "$build_dir" && pwd)
cd "$build_dir"
if [[ ! -d emsdk-3.1.51 ]]; then
  curl -fsSL https://codeload.github.com/emscripten-core/emsdk/tar.gz/refs/tags/3.1.51 | tar xz
fi
if [[ ! -x emsdk-3.1.51/upstream/bin/clang ]]; then
  emsdk-3.1.51/emsdk install 3.1.51
fi
emsdk-3.1.51/emsdk activate 3.1.51
source emsdk-3.1.51/emsdk_env.sh
if [[ ! -d scummvm-2.9.0 ]]; then
  curl -fsSL https://codeload.github.com/scummvm/scummvm/tar.gz/refs/tags/v2.9.0 | tar xz
fi
cd scummvm-2.9.0
already_applied() {
  patch -R -p1 --dry-run --silent --force < "$1" >/dev/null 2>&1
}
apply_if_missing() {
  if ! already_applied "$1"; then
    patch --forward -p1 < "$1"
  fi
}
apply_if_missing "$root/engine/sq3.patch"
apply_if_missing "$root/engine/room-travel.patch"
# Later patches extend the picture-loading and renderer hooks in place.
if ! already_applied "$root/engine/graphics-toggle.patch"; then
  if ! already_applied "$root/engine/picture-loading.patch"; then
    apply_if_missing "$root/engine/art.patch"
    patch --forward -p1 < "$root/engine/picture-loading.patch"
  fi
  patch --forward -p1 < "$root/engine/graphics-toggle.patch"
fi
cp "$root/engine/pre.js" dists/emscripten/custom_shell-pre.js
embuilder build sdl2
emconfigure ./configure --host=wasm32-unknown-emscripten --build=wasm32-unknown-emscripten \
  --disable-all-engines --enable-engine=sci --disable-engine=sci32 --disable-detection-full \
  --disable-debug --enable-release --disable-scalers --disable-hq-scalers --opengl-mode=none \
  --disable-nasm --disable-mt32emu --disable-fluidsynth --disable-flac --disable-libcurl \
  --disable-sdlnet --disable-alsa --disable-timidity --disable-seq-midi
echo 'LDFLAGS += -lidbfs.js' >> config.mk
# Relink the generated loader even when only pre.js has changed.
rm -f scummvm.js
emmake make -j"${JOBS:-4}" EXECUTABLE=scummvm.js scummvm.js
mkdir -p "$root/web/runtime"
cp scummvm.js scummvm.wasm "$root/web/runtime/"
cp COPYING COPYRIGHT "$root/web/runtime/"
cp -R LICENSES "$root/web/runtime/"
