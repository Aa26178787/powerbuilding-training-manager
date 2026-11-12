"""impeccable audit + web-design-guidelines + taste 기준을 실제 화면에서 측정한다.
대비, 터치 영역, 가로 넘침, 잘린 글자, 이름 없는 버튼, 제목 순서, 콘솔 오류, 줄이기 설정."""
import sys, json
from playwright.sync_api import sync_playwright
arm = sys.argv[1]; theme = sys.argv[2] if len(sys.argv) > 2 else 'dark'
D = '/home/claude/shots/audit/'
JS = r"""
() => {
  const out = { contrast: [], small: [], overflowX: document.documentElement.scrollWidth > innerWidth + 1, clipped: [], noname: [], headings: [] };
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bgOf = (el) => { const stack = []; let e = el; while (e) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) stack.push(c); if (c && c.a >= 1) break; e = e.parentElement; } let bg = { r: 255, g: 255, b: 255, a: 1 }; if (!stack.length || stack[stack.length - 1].a < 1) bg = parse(getComputedStyle(document.body).backgroundColor) || bg; for (let i = stack.length - 1; i >= 0; i--) bg = blend(stack[i], bg); return bg; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight * 3; };
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim().slice(0, 30);
  // 대비: 글자를 직접 가진 요소
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.closest('[aria-hidden=true]')) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const s = getComputedStyle(el); const fg = parse(s.color); if (!fg) continue;
    let op = 1; let e = el; while (e) { op *= Number(getComputedStyle(e).opacity); e = e.parentElement; }
    if (el.closest('button:disabled, input:disabled')) continue;
    const bg = bgOf(el); const f = blend({ ...fg, a: fg.a * op }, bg);
    const L1 = lum(f), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(s.fontSize); const bold = Number(s.fontWeight) >= 700; const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    if (ratio < need) out.contrast.push({ text: el.textContent.trim().slice(0, 24), ratio: +ratio.toFixed(2), need, size });
  }
  // 터치 영역
  const targets = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, [role=button], [role=radio], summary, label:has(input[type=checkbox])')].filter(visible);
  for (const el of targets) {
    if (el.matches('label input')) continue;
    const r = el.getBoundingClientRect();
    // after 가상요소로 넓힌 영역은 인정
    const after = getComputedStyle(el, '::after'); const ext = after.content !== 'none' && after.position === 'absolute';
    if ((r.width < 44 || r.height < 44) && !ext) out.small.push({ name: name(el), w: Math.round(r.width), h: Math.round(r.height) });
    if (!name(el) && !el.querySelector('img[alt]')) out.noname.push(el.outerHTML.slice(0, 80));
  }
  // 잘림: 말줄임 없이 넘치는 글자
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue; const s = getComputedStyle(el);
    if ((s.overflowX === 'hidden' || s.overflow === 'hidden') && el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis' && el.textContent.trim() && !el.closest('[aria-hidden=true]')) out.clipped.push(el.textContent.trim().slice(0, 30));
    const r = el.getBoundingClientRect(); if (r.right > innerWidth + 1 && s.position !== 'fixed') out.clipped.push('화면 밖: ' + el.tagName + ' ' + (el.textContent || '').trim().slice(0, 20));
  }
  out.headings = [...document.querySelectorAll('h1,h2,h3')].filter(visible).map((h) => h.tagName + ':' + h.textContent.trim().slice(0, 16));
  const uniq = (a) => [...new Map(a.map((x) => [JSON.stringify(x), x])).values()];
  out.contrast = uniq(out.contrast).slice(0, 15); out.small = uniq(out.small).slice(0, 25); out.clipped = [...new Set(out.clipped)].slice(0, 10);
  return out;
}
"""
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(**p.devices['Pixel 7'], locale='ko-KR', timezone_id='Asia/Seoul')
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type in ('error', 'warning') else None)
    pg.goto('http://localhost:4173/'); pg.wait_for_selector('text=언제부터')
    pg.fill('input[type=date]', '2026-11-09'); pg.fill('input[placeholder="예: 66.0"]', '66')
    seeds = pg.locator('.divide-y input')
    for i, v in enumerate(['150', '5', '8', '105', '5', '8', '180', '4', '8', '170', '4', '8']): seeds.nth(i).fill(v); seeds.nth(i).blur()
    pg.wait_for_timeout(300); pg.tap('button:has-text("부터 시작")'); pg.wait_for_selector('text=원본 달성률')
    if theme == 'light':
        pg.tap('nav >> text=더보기'); pg.locator('text=설정').first.tap(); pg.wait_for_timeout(300)
        pg.locator('select').filter(has_text='어둡게').select_option('light'); pg.wait_for_timeout(300)
    pg.tap('nav >> text=ARM'); pg.set_input_files('input[type=file]', arm); pg.tap('text=이 데이터 가져오기'); pg.wait_for_timeout(400)
    res = {}
    def check(key):
        pg.wait_for_timeout(450); res[key] = pg.evaluate(JS); pg.screenshot(path=f'{D}{theme}-{key}.png')
    pg.tap('nav >> text=홈'); check('home')
    pg.tap('nav >> text=오늘'); pg.wait_for_timeout(300); pg.tap('button:has-text("ARM ")'); pg.evaluate('scrollTo(0,0)'); check('day')
    sec = pg.locator('section[aria-label="Conventional Deadlift"]')
    sec.locator('button[role=radio]:text-is("8")').tap(); pg.locator('.action-pos button').tap(); pg.wait_for_timeout(500); check('day-rest')
    try:
        pg.wait_for_timeout(600); pg.locator('section[aria-label="Conventional Deadlift"] button[aria-label$="메뉴"]').click(timeout=5000); check('menu')
        pg.mouse.click(195, 30); pg.wait_for_timeout(400)
    except Exception as e:
        errs.append('menu step: ' + str(e)[:80])
    pg.locator('button[aria-label="다음 날"]').tap(); check('restday')
    for name, key in [('캘린더', 'calendar'), ('ARM', 'arm')]:
        pg.tap(f'nav >> text={name}'); check(key)
    for label, key in [('프로그램', 'program'), ('운동 기록', 'history'), ('분석', 'analysis'), ('모델 실험실', 'lab'), ('설정', 'settings')]:
        pg.tap('nav >> text=더보기'); pg.wait_for_timeout(250); pg.locator(f'text={label}').first.tap(); check(key)
    print(json.dumps({'theme': theme, 'errors': errs[:10], 'results': res}, ensure_ascii=False, indent=1))
