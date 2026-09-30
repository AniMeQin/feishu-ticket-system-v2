from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


WIDTH = 2400
HEIGHT = 255


def font(size: int) -> ImageFont.FreeTypeFont:
    candidates = (
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    )
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size=size, index=1)
    return ImageFont.load_default()


def make_background() -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), "white")
    pixels = image.load()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            edge = min(1.0, abs(x - WIDTH * 0.50) / (WIDTH * 0.50))
            left_glow = max(0.0, 1.0 - x / (WIDTH * 0.42))
            right_glow = max(0.0, (x - WIDTH * 0.60) / (WIDTH * 0.40))
            vertical = abs(y - HEIGHT / 2) / (HEIGHT / 2)
            lavender = min(1.0, 0.28 * edge + 0.20 * left_glow + 0.24 * right_glow + 0.06 * vertical)
            pixels[x, y] = (
                int(255 - 18 * lavender),
                int(255 - 24 * lavender),
                int(255 - 2 * lavender),
            )

    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for x in range(1330, WIDTH + 100, 120):
        draw.line((x, 0, x - 220, HEIGHT), fill=(126, 92, 220, 18), width=2)
    for y in range(22, HEIGHT, 58):
        draw.line((1120, y, WIDTH, y + 30), fill=(126, 92, 220, 14), width=2)
    return Image.alpha_composite(image.convert("RGBA"), overlay)


def add_illustration(canvas: Image.Image, source_path: Path) -> None:
    source = Image.open(source_path).convert("RGBA")
    # Keep the original IT objects, but scale them into the narrow safe band
    # used by the Feishu form header.
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
    canvas.alpha_composite(crop, (WIDTH - target_width - 128, 8))


def add_title(canvas: Image.Image) -> None:
    draw = ImageDraw.Draw(canvas)
    title = "CATUG IT 工单"
    title_font = font(108)
    x, y = 170, 66
    # A subtle lavender shadow keeps the title crisp on bright screens.
    draw.text((x + 3, y + 3), title, font=title_font, fill=(143, 105, 215, 45))
    draw.text(
        (x, y),
        title,
        font=title_font,
        fill=(45, 16, 67, 255),
        stroke_width=2,
        stroke_fill=(45, 16, 67, 255),
    )

    accent_x = x
    accent_y = 196
    draw.rounded_rectangle((accent_x, accent_y, accent_x + 112, accent_y + 7), radius=4, fill=(116, 76, 210, 220))
    draw.rounded_rectangle((accent_x + 120, accent_y, accent_x + 170, accent_y + 7), radius=4, fill=(190, 165, 239, 180))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    canvas = make_background()
    add_illustration(canvas, args.source)
    add_title(canvas)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(args.output, "PNG", optimize=True)


if __name__ == "__main__":
    main()
