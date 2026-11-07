/**
 * deck.js
 * Turns model markdown into slides, then renders them as
 *  - a themed, keyboard-navigable HTML deck (preview / share page / print to PDF)
 *  - a real, editable .pptx file (via pptxgenjs)
 */

const PptxGenJS = require('pptxgenjs');

const THEMES = {
  ocean:    { name: 'Ocean',    bg: 'F3F8FC', primary: '0B3C5D', accent: '1D9BF0', text: '1F2937', muted: '64748B', titleBg: '0B3C5D', titleText: 'FFFFFF', sub: 'CFE8FF' },
  sunset:   { name: 'Sunset',   bg: 'FFF7F0', primary: '7C2D12', accent: 'F97316', text: '292524', muted: '78716C', titleBg: '7C2D12', titleText: 'FFFFFF', sub: 'FFD9BD' },
  forest:   { name: 'Forest',   bg: 'F4FAF5', primary: '14532D', accent: '22C55E', text: '1F2937', muted: '6B7280', titleBg: '14532D', titleText: 'FFFFFF', sub: 'CDEED5' },
  midnight: { name: 'Midnight', bg: '0F172A', primary: 'F8FAFC', accent: 'A78BFA', text: 'E2E8F0', muted: '94A3B8', titleBg: '1E1B4B', titleText: 'FFFFFF', sub: 'C4B5FD' }
};
const DEFAULT_THEME = 'ocean';

const MAX_SLIDES = 12;
const MAX_BULLETS = 6;
const BULLET_RE = /^\s*([-*\u2022]|\d+[.)])\s+/;

// ---------- helpers ----------
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Split "plain **bold** plain" into runs. */
function runs(text) {
  return String(text)
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map(p =>
      p.length > 4 && p.startsWith('**') && p.endsWith('**')
        ? { text: p.slice(2, -2), bold: true }
        : { text: p.replace(/\*\*/g, ''), bold: false }
    );
}

function inlineHtml(text) {
  return runs(text)
    .map(r => (r.bold ? `<strong>${esc(r.text)}</strong>` : esc(r.text)))
    .join('');
}

/** First slide, or any slide with no bullets, uses the "title" layout. */
function isTitleLayout(slide, index) {
  return index === 0 || slide.bullets.length === 0;
}

function getTheme(key) {
  return THEMES[key] || THEMES[DEFAULT_THEME];
}

// ---------- parsing ----------
function parseSlides(md) {
  md = String(md || '')
    .replace(/^```(?:markdown|md)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();

  return md
    .split(/^##\s+/m)
    .filter(block => block.trim())
    .map(block => {
      const [titleLine, ...rest] = block.split('\n');
      const bullets = rest
        .filter(l => BULLET_RE.test(l))
        .map(l => l.replace(BULLET_RE, '').trim())
        .filter(Boolean)
        .slice(0, MAX_BULLETS);
      return { title: titleLine.replace(/^#+\s*/, '').trim(), bullets };
    })
    .filter(s => s.title)
    .slice(0, MAX_SLIDES);
}

function slidesToMarkdown(slides) {
  return slides
    .map(s => `## ${s.title}\n${s.bullets.map(b => `- ${b}`).join('\n')}`.trimEnd())
    .join('\n\n');
}

// ---------- HTML deck ----------
function renderDeckHtml(slides, themeKey, opts = {}) {
  const t = getTheme(themeKey);
  const title = opts.title || (slides[0] && slides[0].title) || 'Presentation';

  const body = slides
    .map((s, i) => {
      if (isTitleLayout(s, i)) {
        const sub = s.bullets.map(b => `<p>${inlineHtml(b)}</p>`).join('');
        return `<section class="slide title"><div class="inner"><h1>${esc(s.title)}</h1><div class="bar"></div>${sub}</div></section>`;
      }
      const items = s.bullets.map(b => `<li>${inlineHtml(b)}</li>`).join('');
      return `<section class="slide"><div class="side"></div><h2>${esc(s.title)}</h2><ul>${items}</ul><div class="num">${i + 1}</div></section>`;
    })
    .join('\n');

  // opts.id is always a validated hex id, so it is safe to place in a URL here
  const links = opts.id
    ? `<a href="/api/decks/${opts.id}/export.pptx">PowerPoint</a><a href="/d/${opts.id}?print=1" target="_blank" rel="noopener">PDF</a>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --bg:#${t.bg}; --primary:#${t.primary}; --accent:#${t.accent}; --text:#${t.text};
          --muted:#${t.muted}; --titlebg:#${t.titleBg}; --titletext:#${t.titleText}; --sub:#${t.sub}; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; background: #0b1220; font-family: system-ui, -apple-system, "Segoe UI", Roboto, Calibri, sans-serif; }
  .stage { height: calc(100% - 48px); display: flex; align-items: center; justify-content: center; }
  .frame { width: min(100vw, calc((100vh - 48px) * 16 / 9)); aspect-ratio: 16 / 9; position: relative; box-shadow: 0 10px 40px rgba(0,0,0,.45); }
  .slide { position: absolute; inset: 0; display: none; container-type: inline-size; background: var(--bg); color: var(--text); overflow: hidden; }
  .slide.active { display: block; }
  .slide .side { position: absolute; left: 0; top: 0; bottom: 0; width: 1.6cqw; background: var(--accent); }
  .slide h2 { position: absolute; left: 6cqw; right: 6cqw; top: 4.6cqw; font-size: 3.4cqw; line-height: 1.15; color: var(--primary); font-weight: 800; }
  .slide h2::after { content: ""; display: block; width: 8cqw; height: .5cqw; background: var(--accent); margin-top: 1.2cqw; border-radius: 1cqw; }
  .slide ul { position: absolute; left: 6cqw; right: 6cqw; top: 16.5cqw; list-style: none; }
  .slide li { position: relative; padding-left: 3cqw; font-size: 2.35cqw; line-height: 1.35; margin-bottom: 1.7cqw; }
  .slide li::before { content: ""; position: absolute; left: 0; top: .85cqw; width: 1cqw; height: 1cqw; border-radius: 50%; background: var(--accent); }
  .slide .num { position: absolute; right: 3cqw; bottom: 2cqw; font-size: 1.4cqw; color: var(--muted); }
  .slide.title { background: var(--titlebg); color: var(--titletext); }
  .slide.title .inner { position: absolute; left: 7cqw; right: 7cqw; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; }
  .slide.title h1 { font-size: 5cqw; line-height: 1.1; font-weight: 800; }
  .slide.title .bar { width: 12cqw; height: .8cqw; background: var(--accent); margin: 2.2cqw 0; border-radius: 1cqw; }
  .slide.title p { font-size: 2cqw; line-height: 1.5; color: var(--sub); }
  .ui { position: fixed; left: 0; right: 0; bottom: 0; height: 48px; display: flex; gap: 8px; align-items: center; justify-content: center; background: #060b16; color: #cbd5e1; font-size: 14px; }
  .ui button, .ui a { background: #1e293b; color: #e2e8f0; border: 0; border-radius: 8px; padding: 7px 13px; font: inherit; cursor: pointer; text-decoration: none; }
  .ui button:hover, .ui a:hover { background: #334155; }
  .ui .count { min-width: 64px; text-align: center; }
  @page { size: 13.333in 7.5in; margin: 0; }
  @media print {
    html, body { background: #fff; height: auto; }
    .ui { display: none; }
    .stage { display: block; height: auto; }
    .frame { width: 13.333in; aspect-ratio: auto; height: auto; position: static; box-shadow: none; }
    .slide { display: block !important; position: relative; width: 13.333in; height: 7.5in; break-after: page; page-break-after: always;
             -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
<div class="stage"><div class="frame" id="frame">
${body}
</div></div>
<div class="ui">
  <button id="prev" title="Previous (Left arrow)">&#9664;</button>
  <span class="count" id="count"></span>
  <button id="next" title="Next (Right arrow)">&#9654;</button>
  <button id="fs" title="Fullscreen (F)">Fullscreen</button>
  ${links}
</div>
<script>
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var cur = 0;
  function show(n) {
    cur = Math.max(0, Math.min(slides.length - 1, n));
    slides.forEach(function (s, k) { s.classList.toggle('active', k === cur); });
    document.getElementById('count').textContent = (cur + 1) + ' / ' + slides.length;
    try { history.replaceState(null, '', '#' + (cur + 1)); } catch (e) {}
  }
  document.getElementById('prev').onclick = function () { show(cur - 1); };
  document.getElementById('next').onclick = function () { show(cur + 1); };
  document.getElementById('fs').onclick = function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
  };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); show(cur + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(cur - 1); }
    else if (e.key === 'f' || e.key === 'F') document.getElementById('fs').click();
  });
  var startX = null;
  document.addEventListener('touchstart', function (e) { startX = e.touches[0].clientX; });
  document.addEventListener('touchend', function (e) {
    if (startX === null) return;
    var dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 40) show(cur + (dx < 0 ? 1 : -1));
    startX = null;
  });
  var start = parseInt((location.hash || '').replace('#', ''), 10);
  show(isNaN(start) ? 0 : start - 1);
  if (/[?&]print\\b/.test(location.search)) {
    window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 400); });
  }
</script>
</body>
</html>`;
}

// ---------- PPTX ----------
async function buildPptx(slides, themeKey, deckTitle) {
  const t = getTheme(themeKey);
  const font = 'Calibri';
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pptx.title = deckTitle || (slides[0] && slides[0].title) || 'Presentation';

  slides.forEach((s, i) => {
    const slide = pptx.addSlide();

    if (isTitleLayout(s, i)) {
      slide.background = { color: t.titleBg };
      slide.addText(s.title, {
        x: 0.9, y: 1.4, w: 11.5, h: 2.1, fontFace: font, fontSize: 44, bold: true,
        color: t.titleText, valign: 'bottom', margin: 0
      });
      slide.addShape(pptx.ShapeType.rect, {
        x: 0.9, y: 3.7, w: 1.8, h: 0.1, fill: { color: t.accent }, line: { color: t.accent, width: 0 }
      });
      if (s.bullets.length) {
        slide.addText(
          s.bullets.map(b => runs(b).map(r => r.text).join('')).join('\n'),
          { x: 0.9, y: 4.0, w: 11.5, h: 1.8, fontFace: font, fontSize: 20, color: t.sub, valign: 'top', margin: 0 }
        );
      }
      return;
    }

    slide.background = { color: t.bg };
    slide.addShape(pptx.ShapeType.rect, {
      x: 0, y: 0, w: 0.22, h: 7.5, fill: { color: t.accent }, line: { color: t.accent, width: 0 }
    });
    slide.addText(s.title, {
      x: 0.8, y: 0.5, w: 11.8, h: 1.0, fontFace: font, fontSize: 32, bold: true,
      color: t.primary, valign: 'middle', margin: 0
    });
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.8, y: 1.55, w: 1.2, h: 0.07, fill: { color: t.accent }, line: { color: t.accent, width: 0 }
    });

    // One run per bullet: pptxgenjs writes an extra <a:pPr> for every run in a paragraph, which
    // PowerPoint may reject, so **bold** markers are dropped in the .pptx (bold stays in HTML/PDF).
    const items = s.bullets.map(b => ({
      text: runs(b).map(r => r.text).join(''),
      options: { bullet: { characterCode: '25CF', indent: 24 }, breakLine: true, paraSpaceAfter: 12 }
    }));
    slide.addText(items, {
      x: 0.8, y: 1.95, w: 11.7, h: 4.7, fontFace: font,
      fontSize: s.bullets.length > 5 ? 20 : 24, color: t.text, valign: 'top', margin: 0
    });

    slide.addText(String(i + 1), {
      x: 11.9, y: 6.95, w: 1.0, h: 0.3, fontFace: font, fontSize: 11, color: t.muted, align: 'right', margin: 0
    });
  });

  return pptx.write({ outputType: 'nodebuffer' });
}

module.exports = {
  THEMES, DEFAULT_THEME, MAX_SLIDES,
  parseSlides, slidesToMarkdown, renderDeckHtml, buildPptx
};