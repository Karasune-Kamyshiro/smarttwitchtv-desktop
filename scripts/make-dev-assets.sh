#!/usr/bin/env bash
# Generates dev-assets/: a local two-quality HLS test stream and placeholder thumbnails,
# used by STV_MOCK=1 for offline UI work. Needs ffmpeg and python3 with Pillow.
set -euo pipefail
cd "$(dirname "$0")/.."
T=dev-assets
mkdir -p "$T/v720" "$T/v360" "$T/img"

for v in 720:1280x720:2500k 360:640x360:800k; do
    IFS=: read -r name size rate <<<"$v"
    ffmpeg -y -hide_banner -loglevel error \
        -f lavfi -i "testsrc2=size=$size:rate=30" -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 60 \
        -c:v libx264 -preset veryfast -g 60 -b:v "$rate" -c:a aac -b:a 128k \
        -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_filename "$T/v$name/s%03d.ts" "$T/v$name/index.m3u8"
done

python3 - <<'EOF'
from PIL import Image, ImageDraw, ImageFilter
import random
random.seed(7)
pal = [((255,94,58),(255,42,104)),((58,123,213),(0,210,255)),((17,153,142),(56,239,125)),((142,45,226),(74,0,224)),
       ((252,74,26),(247,183,51)),((20,30,48),(36,59,85)),((255,0,132),(51,0,27)),((0,180,219),(0,131,176)),
       ((238,9,121),(255,106,0)),((86,171,47),(168,224,99)),((97,67,133),(81,99,149)),((229,57,53),(227,93,91))]
for i, (a, b) in enumerate(pal):
    im = Image.new('RGB', (640, 360)); d = ImageDraw.Draw(im)
    for y in range(360):
        t = y / 359; d.line([(0, y), (640, y)], fill=tuple(int(a[k] * (1 - t) + b[k] * t) for k in range(3)))
    for _ in range(14):
        r = random.randint(20, 120); x = random.randint(-40, 680); y = random.randint(-40, 400)
        d.ellipse([x - r, y - r, x + r, y + r], fill=tuple(min(255, int(v * 1.25)) for v in random.choice([a, b])))
    im.filter(ImageFilter.GaussianBlur(6)).save(f'dev-assets/img/thumb{i}.jpg', quality=85)
    av = Image.new('RGB', (300, 300), b); ImageDraw.Draw(av).ellipse([60, 60, 240, 240], fill=a)
    av.save(f'dev-assets/img/avatar{i}.jpg')
EOF
echo "dev-assets ready"
