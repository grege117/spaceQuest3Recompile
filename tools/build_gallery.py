#!/usr/bin/env python3
"""Publish numbered shareable PNGs, chapter contact sheets, and a self-contained ZIP."""
from pathlib import Path
import html
import json
import re
import unicodedata
import zipfile

from PIL import Image, ImageDraw, ImageFont, PngImagePlugin

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT/'gallery'
PICS = json.loads((ROOT/'config/pictures.json').read_text())
CHAPTERS = [
    ('The freighter', [900,1,150,153,154,155,156,*range(2,16),157]),
    ('Aboard the Aluminum Mallard', [17,170,18,180,19,161,162,163,164,20]),
    ('Monolith Burger', [27,28,29,25,32,290,291,292,31,30]),
    ('Phleebhut', [112,49,50,51,52,53,41,42,43,44,45,46,47,48,54,40,420,421,470,430]),
    ('Ortega', [113,62,60,61,63,64,66,65,67,68,69,690,70,71,72,73,74,75]),
    ('Pestulon and ScumSoft', [114,80,81,82,85,86,90,91,92,93,94,95,121,122,96,120]),
    ('Homeward bound', [99,115,116,117,83]),
]
ACCENTS = ['#e0b073','#96cee0','#e8a7ae','#e0aee1','#f0a16f','#94c9a5','#9fc1ee']


def font(size, bold=False):
    family = 'DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf'
    return ImageFont.truetype(family, size)


def slug(value):
    ascii_text = unicodedata.normalize('NFKD', value).encode('ascii','ignore').decode()
    return re.sub('[^a-z0-9]+','-',ascii_text.lower()).strip('-')


def source_image(id, entry):
    folder = (ROOT/entry['artwork']).parent
    frame = folder/'preview.png'
    # Some pictures only acquire their subject when the SCI script adds the cast.
    if frame.exists() and entry['kind'] in ('graphic', 'backdrop'):
        return Image.open(frame).convert('RGB').crop((0,10,320,200)), True
    if entry['kind'] == 'backdrop':
        return None, False
    painting = folder/'painting.png'
    if painting.exists() and entry['kind'] == 'painted' and id not in (90,420,690):
        return Image.open(painting).convert('RGB'), False
    return Image.open(folder/'background.png').convert('RGB'), True


def gameplay_sheet(path):
    ids = [2, 8, 28, 49, 62, 92]
    sheet = Image.new('RGB', (1220, 704), '#121a20')
    draw = ImageDraw.Draw(sheet)
    draw.text((24, 20), 'In the game', font=font(32, True), fill='#f2efdf')
    draw.text((26, 66), 'SPACE QUEST III   /   LIVE WASM FRAMES', font=font(16), fill='#96cee0')
    for index, id in enumerate(ids):
        entry = PICS[str(id)]
        folder = (ROOT/entry['artwork']).parent
        with Image.open(folder/'preview.png') as frame:
            image = frame.convert('RGB').resize((374, 234), Image.Resampling.NEAREST)
        x = 24 + index % 3 * 400
        y = 105 + index // 3 * 290
        sheet.paste(image, (x, y))
        draw.text((x, y + 242), entry['name'], font=font(18, True), fill='#e2e6df')
    sheet.quantize(colors=256).save(path, optimize=True)


def main():
    OUT.mkdir(exist_ok=True)
    plates = OUT/'plates'
    plates.mkdir(exist_ok=True)
    sheets = OUT/'contact-sheets'
    sheets.mkdir(exist_ok=True)
    gameplay = sheets/'00-in-the-game.png'
    gameplay_sheet(gameplay)
    published = [gameplay]
    sections = []
    number = 0
    for ch, (chapter, ids) in enumerate(CHAPTERS, 1):
        group = []
        for id in ids:
            entry = PICS[str(id)]
            source, native = source_image(id, entry)
            if source is None:
                continue
            number += 1
            name = entry['name']
            art = source.resize((1280,760), Image.Resampling.NEAREST if native else Image.Resampling.LANCZOS)
            plate = Image.new('RGB',(1280,842),'#121a20')
            plate.paste(art,(0,0))
            draw = ImageDraw.Draw(plate)
            draw.text((30,773),name,font=font(28,True),fill='#f2efdf')
            draw.text((31,810),f'SPACE QUEST III   /   {chapter}',font=font(16),fill=ACCENTS[ch-1])
            draw.text((1250,799),f'{number:03}   /   PIC {id:03}',anchor='rm',font=font(18),fill='#c1c7c9')
            path = plates/f'{number:03}-{slug(name)}-{id:03}.png'
            meta = PngImagePlugin.PngInfo()
            meta.add_text('Title',f'Space Quest III — {name}')
            meta.add_text('Description',f'Gallery plate {number}; SCI picture {id}. Fan artwork based on the Sierra game.')
            # Produce a small indexed PNG without reducing the in-game source palette.
            plate.quantize(colors=256).save(path,pnginfo=meta,optimize=True)
            group.append((path,name,id));published.append(path)
        cards = []
        for page in range(0,len(group),12):
            selection=group[page:page+12]
            sheet=Image.new('RGB',(1216,108+((len(selection)+2)//3)*272),'#121a20')
            draw=ImageDraw.Draw(sheet);draw.text((28,18),chapter,font=font(32,True),fill='#f2efdf')
            draw.text((30,65),'SPACE QUEST III   /   ROOM ART GALLERY',font=font(16),fill=ACCENTS[ch-1])
            for k,(path,name,id) in enumerate(selection):
                x=28+(k%3)*396;y=102+(k//3)*272
                with Image.open(path) as plate:
                    thumb=plate.convert('RGB').crop((0,0,1280,760)).resize((368,219),Image.Resampling.LANCZOS)
                sheet.paste(thumb,(x,y));draw.text((x,y+226),name,font=font(16,True),fill='#e2e6df')
            path=sheets/f'{ch:02}-{slug(chapter)}-{page//12+1}.png'
            sheet.quantize(colors=256).save(path,optimize=True);published.append(path);cards.append(path)
        sections.append((chapter,group,cards))
    sections_html=[]
    for chapter,group,cards in sections:
        entries=''.join(f'<a href="{p.relative_to(OUT)}"><img loading="lazy" width="320" height="211" src="{p.relative_to(OUT)}" alt="{html.escape(name,quote=True)}"></a>' for p,name,id in group)
        contacts = ' · '.join(f'<a href="{sheet.relative_to(OUT)}">Contact sheet {i}</a>' for i,sheet in enumerate(cards,1))
        sections_html.append(f'<section><h2>{html.escape(chapter)}</h2><p>{contacts}</p><div>{entries}</div></section>')
    index=OUT/'index.html'
    index.write_text('''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Space Quest III · Room art gallery</title>
<style>*{box-sizing:border-box}body{margin:0 auto;padding:24px;max-width:1400px;background:#121a20;color:#f2efdf;font:16px/1.5 system-ui,sans-serif}h1{font-size:clamp(2rem,4vw,3.5rem);margin:.4em 0}h2{font-size:1.4rem;margin:1.8em 0 .5em}p{color:#becacb}section div{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(290px,100%),1fr));gap:14px}img{display:block;width:100%;height:auto}a{color:#96cee0}a:focus-visible{outline:3px solid #e0b073}</style>
<h1>Space Quest III</h1>'''+f'<p>{number} room and cinematic plates · Select an image to open its PNG. <a href="{gameplay.relative_to(OUT)}">View gameplay contact sheet</a>.</p>'+''.join(sections_html)+'\n')
    published.append(index)
    archive_path = OUT/'space-quest-iii-gallery.zip'
    temporary_path = archive_path.with_suffix('.zip.tmp')
    with zipfile.ZipFile(temporary_path, 'w') as archive:
        for path in published:
            archive.write(path,str(path.relative_to(OUT)),compress_type=zipfile.ZIP_STORED if path.suffix=='.png' else zipfile.ZIP_DEFLATED)
    temporary_path.replace(archive_path)
    print(f'{number} plates, {1 + sum(len(s) for _,_,s in sections)} contact sheets')


if __name__ == '__main__':
    main()
