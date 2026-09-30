from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


WIDTH = 2400
HEIGHT = 800


def font(path: str, size: int, index: int = 0) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size=size, index=index)


def make_background() -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), "white")
    pixels = image.load()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            horizontal_edge = min(1.0, abs(x - WIDTH / 2) / (WIDTH / 2))
            vertical_edge = min(1.0, abs(y - HEIGHT / 2) / (HEIGHT / 2))
            lavender = min(1.0, 0.16 + 0.17 * horizontal_edge + 0.11 * vertical_edge)
            pixels[x, y] = (
                int(255 - 17 * lavender),
                int(255 - 24 * lavender),
                int(255 - 3 * lavender),
            )

    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for x in range(-300, WIDTH + 300, 190):
        draw.line((x, HEIGHT, x + 720, 0), fill=(122, 83, 214, 16), width=2)
    for y in range(90, HEIGHT, 125):
        draw.line((0, y, WIDTH, y + 72), fill=(122, 83, 214, 10), width=2)
    return Image.alpha_composite(image.convert("RGBA"), overlay)


def add_title(canvas: Image.Image) -> None:
    draw = ImageDraw.Draw(canvas)
    chinese_font = font("/System/Library/Fonts/STHeiti Medium.ttc", 76)
    english_font = font("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 35)

    x = 525
    chinese_y = 317
    english_y = 420
    title_color = (45, 16, 67, 255)
    english_color = (89, 58, 116, 235)

    draw.text(
        (x, chinese_y),
        "国际员工出差申请表",
        font=chinese_font,
        fill=title_color,
        stroke_width=1,
        stroke_fill=title_color,
    )
    draw.text(
        (x, english_y),
        "International Employee Business Travel Application",
        font=english_font,
        fill=english_color,
    )

    draw.rounded_rectangle((x, 481, x + 112, 489), radius=4, fill=(116, 76, 210, 220))
    draw.rounded_rectangle((x + 120, 481, x + 170, 489), radius=4, fill=(190, 165, 239, 180))


def add_illustration(canvas: Image.Image, source_path: Path) -> None:
    source = Image.open(source_path).convert("RGBA")
    crop = source.crop((720, 85, 1665, 865))
    target_height = 245
    target_width = round(crop.width * target_height / crop.height)
    crop = crop.resize((target_width, target_height), Image.Resampling.LANCZOS)

    mask = Image.new("L", crop.size, 255)
    edge = 28
    mask_draw = ImageDraw.Draw(mask)
    for i in range(edge):
        alpha = round(255 * i / edge)
        mask_draw.rectangle(
            (i, i, crop.width - 1 - i, crop.height - 1 - i),
            outline=alpha,
        )
    mask = mask.filter(ImageFilter.GaussianBlur(9))
    crop.putalpha(mask)
    canvas.alpha_composite(crop, (1450, 278))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    canvas = make_background()
    add_title(canvas)
    add_illustration(canvas, args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(args.output, "PNG", optimize=True)


if __name__ == "__main__":
    main()
