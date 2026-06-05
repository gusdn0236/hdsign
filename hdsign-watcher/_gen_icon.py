"""easyform_agent.ico 생성 — 주황 라운드 사각형 + 흰 '명세'. (일회성, 커밋 제외)"""
from PIL import Image, ImageDraw, ImageFont

SZ = 256
img = Image.new("RGBA", (SZ, SZ), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([10, 10, SZ - 10, SZ - 10], radius=52, fill=(245, 124, 0, 255))
try:
    f = ImageFont.truetype(r"C:\Windows\Fonts\malgunbd.ttf", 104)
except Exception:
    f = ImageFont.load_default()
t = "명세"
b = d.textbbox((0, 0), t, font=f)
w, h = b[2] - b[0], b[3] - b[1]
d.text(((SZ - w) / 2 - b[0], (SZ - h) / 2 - b[1] - 6), t, font=f, fill="white")
out = r"C:\Users\USER\Desktop\hdsign\hdsign-watcher\easyform_agent.ico"
img.save(out, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print("icon saved:", out)
