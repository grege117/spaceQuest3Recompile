#!/usr/bin/env python3
"""Extract a configured SCI room or compile its VGA painting and sprite atlas."""
import argparse
import base64
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
EGA = np.array([
    [0, 0, 0], [0, 0, 170], [0, 170, 0], [0, 170, 170],
    [170, 0, 0], [170, 0, 170], [170, 85, 0], [170, 170, 170],
    [85, 85, 85], [85, 85, 255], [85, 255, 85], [85, 255, 255],
    [255, 85, 85], [255, 85, 255], [255, 255, 85], [255, 255, 255]
], dtype=np.uint8)

# Material colors for the original ink indices. Human figures have different
# materials than the hatch, transport machinery and portable engine parts.
CLOTH = ["18151e", "253555", "396b58", "31616c", "803e31", "72374f", "855035",
         "9c9d9c", "4f5963", "567caa", "819968", "86ccc1", "edab83", "c27378", "e6be74", "e2ded1"]
METAL = ["12191f", "23334a", "3e6048", "34666c", "7e3d2e", "674658", "895835",
         "9aa6a6", "53616a", "536f91", "84a571", "77cfcd", "cb7959", "a46d7b", "d9ba76", "dcdfd7"]


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2) + "\n")


def extract(capture, room, art):
    source_dir = art / "source"
    payload = json.loads(capture.read_text())
    data = payload.get("sourceArt", payload)
    pic = data["picture"]
    if (pic["id"], pic["width"], pic["height"]) != (room, 320, 190):
        raise ValueError(f"Expected SCI picture {room} at 320 × 190")
    source_dir.mkdir(parents=True, exist_ok=True)
    planes = np.frombuffer(base64.b64decode(pic["planes"]), np.uint8).reshape(190, 320, 3)
    Image.fromarray(EGA[planes[:, :, 0]]).save(source_dir / "background.png")
    for channel, name in [(1, "priority"), (2, "control")]:
        Image.fromarray(planes[:, :, channel] * 17).save(source_dir / (name + ".png"))

    # Pack complete decoded cels, including loops mirrored by the interpreter.
    x, y, row_height = 1, 1, 0
    entries, images = [], []
    for cel in data["cels"]:
        w, h = cel["width"], cel["height"]
        if x + w >= 512:
            x, y, row_height = 1, y + row_height + 2, 0
        pixels = np.frombuffer(base64.b64decode(cel["pixels"]), np.uint8).reshape(h, w)
        rgba = np.dstack((EGA[pixels], np.uint8(pixels != cel["clear"]) * 255))
        images.append((Image.fromarray(rgba), (x, y)))
        entries.append({k: v for k, v in cel.items() if k != "pixels"} | {"x": x, "y": y})
        x += w + 2
        row_height = max(row_height, h)
    atlas = Image.new("RGBA", (512, y + row_height + 1))
    for image, position in images:
        atlas.paste(image, position)
    atlas.save(source_dir / "sprites.png")
    write_json(source_dir / "resources.json", {"picture": room, "origin": [pic["x"], pic["y"]],
               "width": 320, "height": 190, "cels": entries})


def hatch_bounds(image):
    # Limit the search to the pod so blue fixtures elsewhere cannot win.
    rgb = np.asarray(image, dtype=float)[75:122, 114:163]
    r, g, b = rgb.transpose(2, 0, 1)
    y, x = np.where((g > 140) & (b > 140) & (g > r + 55) & (b > r + 55))
    if len(x) < 50:
        raise ValueError("Could not register the cyan hatch inside the pod")
    return np.array([114 + x.min(), 75 + y.min(), 114 + x.max(), 75 + y.max()])


def register_hatch(original, painting):
    from PIL import ImageTransform

    target, source = hatch_bounds(original), hatch_bounds(painting)
    # Align the painted hatch with its scripted 37 × 33 door. Fade the warp
    # outside the pod so the frame edges and the walkable floor stay fixed.
    def source_point(x, y):
        center = (target[:2] + target[2:]) / 2
        p = np.array([x, y])
        falloff = np.maximum(abs(p - center) - (target[2:] - target[:2]) / 2, 0)
        weight = np.exp(-sum((falloff / [22, 16]) ** 2))
        mapped = source[:2] + (p-target[:2]) * (source[2:]-source[:2]) / (target[2:]-target[:2])
        return tuple(p + weight * (mapped - p))

    w, h = original.size
    mesh = []
    for y in range(0, h, 8):
        for x in range(0, w, 8):
            right, bottom = min(w, x+8), min(h, y+8)
            quad = sum((source_point(xx, yy) for xx, yy in [(x,y),(x,bottom),(right,bottom),(right,y)]), ())
            mesh.append(((x,y,right,bottom), quad))
    return painting.transform(original.size, ImageTransform.MeshTransform(mesh), Image.Resampling.BICUBIC)


def shade_sprite(sprite, view):
    rgba = np.asarray(sprite)
    inks = np.zeros(rgba.shape[:2], np.uint8)
    for index, color in enumerate(EGA):
        inks[(rgba[:, :, :3] == color).all(axis=2)] = index
    swatches = CLOTH if view in (0, 6, 11) else METAL
    rgb = np.array([list(bytes.fromhex(c)) for c in swatches])[inks].astype(float)
    # Local relief follows edges inside each cel. Work cel-by-cel so lighting
    # stays attached to the sprite as it walks and does not sample its neighbors.
    luma = Image.fromarray(np.uint8(rgb @ [0.30, 0.59, 0.11]))
    soft = np.asarray(luma.filter(ImageFilter.GaussianBlur(1)), dtype=float)
    padded = np.pad(soft, 1, mode="edge")
    relief = np.clip((padded[2:, 2:] - padded[:-2, :-2]) * .31, -23, 23)
    y, x = np.indices(inks.shape)
    light = 9 - 14 * y / max(1, sprite.height-1) - 4 * x / max(1, sprite.width-1)
    shaded = np.uint8(np.clip(rgb + (relief + light)[:, :, None], 0, 255))
    return Image.fromarray(np.dstack((shaded, rgba[:, :, 3])))


def compile_pack(art):
    source_dir = art / "source"
    source = json.loads((source_dir / "resources.json").read_text())
    original_picture = Image.open(source_dir / "background.png").convert("RGB")
    background = Image.open(art / "painting.png").convert("RGB").resize(original_picture.size, Image.Resampling.LANCZOS)
    if source["picture"] == 2:
        background = register_hatch(original_picture, background)
    original = Image.open(source_dir / "sprites.png").convert("RGBA")
    sprites = Image.new("RGBA", original.size)
    for entry in source["cels"]:
        x, y, w, h = (entry[k] for k in ("x", "y", "width", "height"))
        sprite = shade_sprite(original.crop((x, y, x+w, y+h)), entry["view"])
        sprites.paste(sprite, (x, y))

    # Reserve the native 16 EGA entries and color 255 for SCI menus and text.
    # Allocate part of the remaining palette specifically to the small actors.
    bg_palette = background.quantize(colors=191).getpalette()[:191*3]
    opaque = np.asarray(sprites)
    samples = opaque[opaque[:, :, 3] > 0, :3].reshape(-1, 1, 3)
    sprite_palette = Image.fromarray(samples).quantize(colors=48).getpalette()[:48*3]
    colors = bg_palette + sprite_palette
    table = Image.new("P", (1, 1))
    table.putpalette(colors + colors[:3] * 17)
    bg = background.quantize(palette=table, dither=Image.Dither.NONE).convert("RGB")
    bg.save(art / "background.png")
    atlas = sprites.convert("RGB").quantize(palette=table, dither=Image.Dither.NONE).convert("RGBA")
    atlas.putalpha(sprites.getchannel("A"))
    atlas.save(art / "sprites.png")
    write_json(art / "manifest.json", {**source, "background": "background.png", "atlas": "sprites.png",
               "palette": np.asarray(colors).reshape(-1, 3).tolist()})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extract", type=Path, metavar="CAPTURE", help="unpack a browser source capture first")
    parser.add_argument("--room", type=int, default=2, help="SCI room ID (default 2)")
    parser.add_argument("--extract-only", action="store_true", help="write source layers before creating a painting")
    options = parser.parse_args()
    rooms = json.loads((ROOT / "config/game.json").read_text())["rooms"]
    manifest = rooms.get(str(options.room), {}).get("artwork")
    if not manifest:
        parser.error("room has no configured artwork")
    if options.extract_only and not options.extract:
        parser.error("--extract-only requires --extract")
    art = (ROOT / manifest).parent
    if options.extract:
        extract(options.extract, options.room, art)
    if not options.extract_only:
        compile_pack(art)
