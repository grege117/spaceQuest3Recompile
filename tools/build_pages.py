#!/usr/bin/env python3
"""Stage the public site from a positive list of runtime and enhanced-art assets."""
import json
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "_site"


def build(site):
    def copy(relative):
        dest = site / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, dest)

    copy("index.html")
    for name in ("game.css", "game.js", "game-archive.js", "artwork.js", "scene.js",
                 "vendor/fflate/browser.js", "vendor/fflate/LICENSE",
                 "runtime/scummvm.js", "runtime/scummvm.wasm", "runtime/COPYING", "runtime/COPYRIGHT"):
        copy(Path("web") / name)
    for license_file in (ROOT / "web/runtime/LICENSES").iterdir():
        copy(license_file.relative_to(ROOT))
    for name in ("pictures", "game"):
        copy(f"config/{name}.json")

    for name in ("sprites.png", "cels.json"):
        copy(Path("art/shared") / name)
    catalog = json.loads((ROOT / "config/pictures.json").read_text())
    for entry in catalog.values():
        if entry["kind"] == "overlay":
            continue  # SCI draws these from the imported game.
        manifest = Path(entry["artwork"])
        folder = manifest.parent
        pack = json.loads((ROOT / manifest).read_text())
        copy(manifest)
        if pack["background"]:
            copy(folder / "background.png")
        if entry["artworkViews"] or not pack.get("sharedCels"):
            copy(folder / "sprites.png")
        copy(folder / "source/resources.json")
        if entry.get("castSample"):
            copy(folder / "source/cast.json")
            copy(folder / "preview.png")

    copy("gallery/index.html")
    for folder in ("plates", "contact-sheets"):
        for image in (ROOT / "gallery" / folder).glob("*.png"):
            copy(image.relative_to(ROOT))
    # Construct the gallery archive from the staged public files only.
    gallery = site / "gallery"
    files = sorted(p for p in gallery.rglob("*") if p.is_file())
    with ZipFile(gallery / "space-quest-iii-gallery.zip", "w") as archive:
        for path in files:
            archive.write(path, path.relative_to(gallery))


if __name__ == "__main__":
    with TemporaryDirectory(dir=ROOT, prefix=".pages-") as temporary:
        staged = Path(temporary) / "site"
        build(staged)
        if OUTPUT.exists():
            shutil.rmtree(OUTPUT)
        staged.rename(OUTPUT)
    print(f"Public site ready in {OUTPUT}")
