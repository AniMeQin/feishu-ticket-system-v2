from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


WIDTH = 2400
HEIGHT = 800


def load_font(size: int) -> ImageFont.FreeTypeFont:
    candidates = (
        ("/System/Library/Fonts/STHeiti Medium.ttc", 0),
        ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 0),
    )
    for candidate, index in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size=size, index=index)
    return ImageFont.load_default()


def background() -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), "white")
    pixels = image.load()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            horizontal_edge = min(1.0, abs(x - WIDTH / 2) / (WIDTH / 2))
            vertical_edge = min(1.0, abs(y - HEIGHT / 2) / (HEIGHT / 2))
            lavender = min(1.0, 0.18 + 0.16 * horizontal_edge + 0.12 * vertical_edge)
            pixels[x, y] = (
                int(255 - 17 * lavender),
                int(255 - 24 * lavender),
                int(255 - 3 * lavender),
            )

    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for x in range(-200, WIDTH + 300, 180):
        draw.line((x, HEIGHT, x + 700, 0), fill=(122, 83, 214, 17), width=2)
    for y in range(80, HEIGHT, 120):
        draw.line((0, y, WIDTH, y + 70), fill=(122, 83, 214, 11), width=2)
    return Image.alpha_composite(image.convert("RGBA"), overlay)


def add_title(canvas: Image.Image) -> None:
    draw = ImageDraw.Draw(canvas)
    title = "CATUG IT 工单"
    title_font = load_font(112)
    bbox = draw.textbbox((0, 0), title, font=title_font, stroke_width=2)
    title_width = bbox[2] - bbox[0]
    x = 1210 - title_width
    y = 337
    draw.text((x + 3, y + 3), title, font=title_font, fill=(138, 99, 211, 42))
    draw.text(
        (x, y),
        title,
        font=title_font,
        fill=(45, 16, 67, 255),
        stroke_width=2,
        stroke_fill=(45, 16, 67, 255),
    )
    draw.rounded_rectangle((x, 472, x + 112, 480), radius=4, fill=(116, 76, 210, 220))
    draw.rounded_rectangle((x + 120, 472, x + 170, 480), radius=4, fill=(190, 165, 239, 180))


def add_illustration(canvas: Image.Image, source_path: Path) -> None:
    source = Image.open(source_path).convert("RGBA")
    crop = source.crop((1160, 72, 2160, 666))
    target_height = 238
    target_width = round(crop.width * target_height / crop.height)
    crop = crop.resize((target_width, target_height), Image.Resampling.LANCZOS)

    mask = Image.new("L", crop.size, 255)
    edge = 26
    mask_draw = ImageDraw.Draw(mask)
    for i in range(edge):
        alpha = round(255 * i / edge)
        mask_draw.rectangle((i, i, crop.width - 1 - i, crop.height - 1 - i), outline=alpha)
    mask = mask.filter(ImageFilter.GaussianBlur(8))
    crop.putalpha(mask)
    canvas.alpha_composite(crop, (1390, 281))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    canvas = background()
    add_title(canvas)
    add_illustration(canvas, args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(args.output, "PNG", optimize=True)


if __name__ == "__main__":
    main()
