"""Generate phone app icons and splash screens from public/icon-512.png (run after `cap add`)."""
from PIL import Image
import glob, os
src = Image.open('public/icon-512.png').convert('RGBA')
BG = (11, 13, 18, 255)
def fit(size, pad=0.0, bg=None):
    canvas = Image.new('RGBA', (size, size), bg or (0, 0, 0, 0))
    inner = int(size * (1 - 2 * pad))
    canvas.alpha_composite(src.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2,) * 2)
    return canvas
for f in glob.glob('android/app/src/main/res/mipmap-*/ic_launcher*.png'):
    w = Image.open(f).size[0]
    img = fit(w, 0.18) if 'foreground' in f else fit(w, 0.0, BG)
    img.save(f)
# Adaptive icon background colour
bgxml = 'android/app/src/main/res/values/ic_launcher_background.xml'
if os.path.exists(bgxml):
    open(bgxml, 'w').write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0B0D12</color>\n</resources>\n')
for f in glob.glob('android/app/src/main/res/drawable*/splash.png'):
    w, h = Image.open(f).size
    img = Image.new('RGBA', (w, h), BG)
    s = int(min(w, h) * 0.28)
    img.alpha_composite(src.resize((s, s), Image.LANCZOS), ((w - s) // 2, (h - s) // 2))
    img.convert('RGB').save(f)
ios = 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'
if os.path.exists(ios):
    fit(1024, 0.0, BG).convert('RGB').save(ios)  # iOS icons must not be transparent
for f in glob.glob('ios/App/App/Assets.xcassets/Splash.imageset/*.png'):
    w, h = Image.open(f).size
    img = Image.new('RGB', (w, h), BG[:3])
    s = int(min(w, h) * 0.22)
    img.paste(src.resize((s, s), Image.LANCZOS), ((w - s) // 2, (h - s) // 2), src.resize((s, s), Image.LANCZOS))
    img.save(f)
print('icons + splash written')
