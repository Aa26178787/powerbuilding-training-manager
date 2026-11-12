"""Pretendard Variable에서 앱에 필요한 글자만 남긴 서체 하나를 만든다.
- KS X 1001 한글 2,350자 + 호환 자모 + 기본 라틴·숫자·기호 + 소스 코드에 쓰인 모든 글자
- Pretendard는 OFL의 '예약 서체 이름'이 있어, 수정본(부분 집합)은 다른 이름(PTM Sans)을 쓴다
실행: python3 scripts/subset-font.py  (fonttools, brotli 필요)
"""
import pathlib, re
from fontTools import subset
from fontTools.ttLib import TTFont

root = pathlib.Path(__file__).resolve().parent.parent
src = root / 'node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2'
out = root / 'src/assets/fonts/ptm-sans.woff2'

chars = set(range(0x20, 0x7F)) | set(range(0xA0, 0x100)) | set(range(0x2010, 0x2060)) | set(range(0x2190, 0x2200)) | {0x2212, 0x2264, 0x2265, 0x221E, 0x2026, 0x00D7, 0x3001, 0x3002, 0x300C, 0x300D}
chars |= set(range(0x3131, 0x318F))
for cp in range(0xAC00, 0xD7A4):
    try:
        if len(chr(cp).encode('euc-kr')) == 2: chars.add(cp)
    except UnicodeEncodeError:
        pass
for f in (root / 'src').rglob('*'):
    if f.suffix in ('.ts', '.tsx', '.css', '.json'):
        chars |= {ord(c) for c in f.read_text(encoding='utf-8')}
chars = {c for c in chars if c >= 0x20}

opts = subset.Options()
opts.flavor = 'woff2'
opts.layout_features = ['*']
opts.name_IDs = ['*']
opts.notdef_outline = True
font = TTFont(src)
sub = subset.Subsetter(options=opts)
sub.populate(unicodes=chars)
sub.subset(font)
# 예약 서체 이름 대신 새 이름
for rec in font['name'].names:
    if rec.nameID in (1, 4, 6, 16, 21):
        t = rec.toUnicode()
        rec.string = re.sub(r'Pretendard', 'PTM Sans', t).replace(' ', '-' if rec.nameID == 6 else ' ')
font.flavor = 'woff2'
font.save(out)
print(out, out.stat().st_size, 'bytes,', len(chars), 'chars')
