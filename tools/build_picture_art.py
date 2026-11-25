#!/usr/bin/env python3
"""Compile SCI picture packs and the shared view atlas from the checked-in source layers."""
import argparse
from collections import defaultdict
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

from junk_bay_art import EGA, ROOT, shade_sprite, write_json

SHARED = ROOT / 'art/shared'
CATALOG = json.loads((ROOT / 'config/pictures.json').read_text())
# Display inks for the precise CRT lettering, grid lines and animated starfields.
INK = np.array([[0, 0, 0], [27, 43, 109], [38, 145, 73], [36, 147, 155],
                [164, 45, 47], [139, 49, 130], [166, 105, 49], [172, 176, 182],
                [79, 88, 104], [91, 126, 232], [124, 235, 128], [111, 233, 240],
                [247, 106, 89], [228, 134, 215], [248, 213, 111], [239, 241, 230]], dtype=np.uint8)


def box(cel):
    x, y = cel['x'], cel['y']
    return (x, y, x + cel['width'], y + cel['height'])


def shared_sprites():
    original = Image.open(SHARED / 'original.png').convert('RGBA')
    cels = json.loads((SHARED / 'cels.json').read_text())
    shaded = Image.new('RGBA', original.size)
    for cel in cels:
        x, y, _, _ = box(cel)
        shaded.paste(shade_sprite(original.crop(box(cel)), cel['view']), (x, y))
    rgba = np.asarray(shaded)
    opaque = rgba[rgba[:, :, 3] > 0, :3].reshape(-1, 1, 3)
    colors = Image.fromarray(opaque).quantize(colors=48).getpalette()[:144]
    table = Image.new('P', (1, 1))
    table.putpalette(colors + colors[:3] * (256-48))
    atlas = shaded.convert('RGB').quantize(palette=table, dither=Image.Dither.NONE).convert('RGBA')
    atlas.putalpha(shaded.getchannel('A'))
    atlas.save(SHARED / 'sprites.png')
    write_json(SHARED / 'palette.json', np.array(colors).reshape(-1, 3).tolist())


def ink_picture(original):
    arr = np.asarray(original)
    indices = np.zeros(arr.shape[:2], dtype=np.uint8)
    for i, color in enumerate(EGA):
        indices[np.all(arr == color, axis=2)] = i
    rgb = INK[indices].astype(float)
    # A narrow phosphor halo preserves every solid letter and star at its source pixel.
    halo = np.asarray(Image.fromarray(INK[indices]).filter(ImageFilter.GaussianBlur(1.15)))
    lit = np.clip(rgb + np.maximum(halo - rgb, 0) * .25, 0, 255).astype(np.uint8)
    return Image.fromarray(lit)


def variant(id, original):
    base = {65: 66, 156: 155, 157: 15}[id]
    folder = (ROOT / CATALOG[str(base)]['artwork']).parent
    painting = Image.open(folder / 'painting.png').convert('RGB').resize(original.size, Image.Resampling.LANCZOS)
    a = np.asarray(painting).astype(float)
    if id == 156:  # The sleep chamber switches to its red warning light.
        a = a * [1.22, .69, .63] + [7, 0, 0]
    elif id == 157:  # The reactor has been taken and the lamps lose power.
        a = a * [.42, .50, .65]
    else:  # Only the small falling ledge differs between the two crevice pictures.
        before = np.asarray(Image.open(folder/'source/background.png').convert('RGB'))
        changed = Image.fromarray(np.uint8(np.any(before != np.asarray(original), axis=2)) * 255)
        edge = changed.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(1.5))
        state = (ROOT / CATALOG[str(id)]['artwork']).parent
        after = Image.open(state / 'painting.png').convert('RGB').resize(original.size, Image.Resampling.LANCZOS)
        return Image.composite(after, painting, edge)
    return Image.fromarray(np.uint8(np.clip(a, 0, 255)))


def local_sheets(folder, views, by_view, sheets, id):
    x, y, row_height = 1, 1, 0
    placements = []
    for view in views:
        for cel in by_view[view]:
            w, h = cel['width'], cel['height']
            if x + w >= 512:
                x, y, row_height = 1, y + row_height + 2, 0
            placements.append((cel, x, y))
            x += w + 2
            row_height = max(row_height, h)
    for sheet, dest in zip(sheets, [folder/'source/sprites.png', folder/'sprites.png']):
        page = Image.new('RGBA', (512, y+row_height+1))
        for cel, x, y in placements:
            page.paste(sheet.crop(box(cel)), (x, y))
        page.save(dest)
    metadata = {'picture': id, 'origin': [0, 10], 'width': 320, 'height': 190,
                'cels': [{**cel, 'x': x, 'y': y} for cel, x, y in placements]}
    (folder/'source/resources.json').write_text(json.dumps(metadata, separators=(',', ':'))+'\n')


def build(ids, sheets=True):
    by_view = defaultdict(list)
    for cel in json.loads((SHARED/'cels.json').read_text()):
        by_view[cel['view']].append(cel)
    sprite_colors = json.loads((SHARED/'palette.json').read_text())
    atlases = [Image.open(SHARED/file).convert('RGBA') for file in ['original.png', 'sprites.png']]
    for id in ids:
        entry = CATALOG[str(id)]
        if 2 <= id <= 7:  # These six rooms have individually compiled sprite palettes.
            continue
        folder = (ROOT / entry['artwork']).parent
        if sheets:
            local_sheets(folder, entry['artworkViews'], by_view, atlases, id)
        original = Image.open(folder/'source/background.png').convert('RGB')
        if entry['kind'] == 'painted':
            picture = Image.open(folder/'painting.png').convert('RGB').resize(original.size, Image.Resampling.LANCZOS)
        elif entry['kind'] == 'variant':
            picture = variant(id, original)
        elif entry['kind'] == 'overlay':
            # The live interpreter paints this vector layer onto the existing picture.
            picture = original
        else:
            picture = ink_picture(original)
        if id in (90, 420, 690):
            # Keep the unused area surrounding the inset/eyepiece perfectly black.
            black = np.all(np.asarray(original) == 0, axis=2)
            mask = Image.fromarray(black.astype(np.uint8)*255).filter(ImageFilter.MinFilter(5))
            picture.paste((0, 0, 0), (0, 0), mask)
        pal = picture.quantize(colors=191)
        background = pal.convert('RGB')
        background.save(folder/'background.png')
        colors = list(pal.getpalette()[:573])
        colors += [0]*(573-len(colors))
        manifest = {'picture': id, 'origin': [0, 10], 'width': 320, 'height': 190,
                    'background': None if id in (121, 161, 777) else 'background.png', 'atlas':'../../shared/sprites.png',
                    'sharedCels':'../../shared/cels.json',
                    'palette':np.array(colors).reshape(-1,3).tolist()+sprite_colors}
        (folder/'manifest.json').write_text(json.dumps(manifest, separators=(',', ':'))+'\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--shared', action='store_true', help='also recompile the shared 48-color view atlas')
    parser.add_argument('pictures', type=int, nargs='*', help='SCI pictures; defaults to the entire shared-atlas collection')
    args = parser.parse_args()
    if args.shared:
        shared_sprites()
    build(args.pictures or list(map(int, CATALOG)))
