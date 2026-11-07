/**
 * ppt_slidemaker server
 *
 * UI:        GET  /                          -> public/index.html
 * Config:    GET  /api/config                -> public Clerk publishable key for the browser
 * Decks:     POST /api/generate              -> model writes slides, deck is saved, returns preview html + share link
 *            PUT  /api/decks/:id             -> update slides (markdown) and/or theme
 *            GET  /api/decks/:id/export.pptx -> real PowerPoint file
 *            GET  /api/decks/:id/export.html -> standalone HTML file
 *            GET  /d/:id                     -> shareable presentation page (add ?print=1 for PDF)
 *            GET  /api/themes                -> theme list for the UI
 * Agent:     POST /api/generate-pptx         -> optional ppt-master agent job (see pptAgent.js)
 *            GET  /api/jobs/:id              -> agent job status
 *
 * Co-Authored-By: Claude Code <noreply@anthropic.com>
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  THEMES, DEFAULT_THEME, MAX_SLIDES,
  parseSlides, slidesToMarkdown, renderDeckHtml, buildPptx
} = require('./Deck');
const { startJob, getJob, checkSetup, WORKSPACE_ROOT, SKILL_DIR } = require('./Pptagent');
const { testConnection, initDatabase, loadDeck, saveDeck } = require('./db');
const { requireAuth, getUser } = require('./clerk');
const { uploadFile, deleteObject, getPutObjectUrl, getObjectUrl } = require('./s3');

// ---------- config ----------
const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';
const DECK_DIR = path.join(__dirname, 'decks');
fs.mkdirSync(DECK_DIR, { recursive: true });

if (!process.env.OPENROUTER_API_KEY) {
  console.error('Missing OPENROUTER_API_KEY in .env file');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);

// ---------- middleware ----------
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(WORKSPACE_ROOT)); // agent job outputs

// very small per-IP rate limit (protects your OpenRouter credits)
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const recent = (hits.get(req.ip) || []).filter(t => now - t < 60000);
  if (recent.length >= 10) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  }
  recent.push(now);
  hits.set(req.ip, recent);
  next();
}
// drop stale entries so the map does not grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of hits) {
    const recent = times.filter(t => now - t < 60000);
    if (recent.length) hits.set(ip, recent); else hits.delete(ip);
  }
}, 60000).unref();

// Express 4 does not catch rejected promises from async handlers, so wrap them.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- database ----------
async function initializeDatabase() {
  const connected = await testConnection();
  if (!connected) {
    console.error('Failed to connect to database. Exiting.');
    process.exit(1);
  }
  await initDatabase();
}

const dbReady = initializeDatabase();
dbReady.catch(e => {
  console.error('Database init failed:', e);
  process.exit(1);
});

function deckResponse(deck) {
  return {
    id: deck.id,
    title: deck.title,
    theme: deck.theme,
    markdown: slidesToMarkdown(deck.slides),
    slideCount: deck.slides.length,
    html: renderDeckHtml(deck.slides, deck.theme, { title: deck.title }),
    shareUrl: `/d/${deck.id}`
  };
}

// Loads a deck and checks ownership. Sends the error response itself and returns null on failure.
async function getOwnedDeck(req, res, { text = false } = {}) {
  const deck = await loadDeck(req.params.id);
  if (!deck) {
    text ? res.status(404).send('Deck not found') : res.status(404).json({ error: 'Deck not found' });
    return null;
  }
  if (deck.userId && deck.userId !== req.auth.userId) {
    text ? res.status(403).send('Access denied') : res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return deck;
}

function safeTheme(key) {
  return THEMES[key] ? key : DEFAULT_THEME;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'presentation';
}

// keep user-supplied file names from adding path segments or odd characters to S3 keys
function safeFilename(name) {
  const base = String(name).split(/[\\/]/).pop();
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
}

// ---------- model call ----------
async function generateSlides(prompt, count) {
  const system =
    'You are a presentation writer. Output ONLY markdown, no commentary and no code fences. ' +
    `Write exactly ${count} slides. Each slide starts with a line "## <Slide Title>" followed by 3 to 5 bullet points, each starting with "- ". ` +
    'The FIRST slide is the title slide: its title is the deck title and it has one or two short bullet lines as a subtitle. ' +
    'Keep bullets under 14 words. Use **bold** sparingly for key terms.';

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 8192 // reasoning models spend tokens on thinking first
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': `http://localhost:${PORT}`,
        'X-Title': 'ppt-slidemaker'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150000)
    });

    if (response.status === 429 && attempt < 2) {
      await new Promise(r => setTimeout(r, 3000)); // free tier is rate limited: retry once
      continue;
    }
    if (!response.ok) {
      throw new Error(`OpenRouter error ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) throw new Error('Model returned empty content. Try again or raise max_tokens.');
    return text;
  }
}

// ---------- routes: config + themes ----------
// The publishable key is meant for browsers. Never expose CLERK_SECRET_KEY here.
app.get('/api/config', (req, res) => {
  res.json({ clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || '' });
});

app.get('/api/themes', (req, res) => {
  const list = Object.entries(THEMES).map(([key, t]) => ({
    key, name: t.name, primary: t.primary, accent: t.accent, bg: t.bg
  }));
  res.json({ default: DEFAULT_THEME, themes: list });
});

// ---------- routes: decks ----------
app.post('/api/generate', rateLimit, requireAuth, async (req, res) => {
  const { prompt, theme, slides: n } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Missing prompt' });
  }
  if (prompt.length > 4000) {
    return res.status(400).json({ error: 'Prompt too long (max 4000 characters)' });
  }
  const count = Math.min(MAX_SLIDES, Math.max(3, parseInt(n, 10) || 7));

  try {
    const md = await generateSlides(prompt.trim(), count);
    const slides = parseSlides(md);
    if (!slides.length) throw new Error('Could not read any slides from the model output. Try again.');

    const deck = {
      id: crypto.randomBytes(6).toString('hex'),
      title: slides[0].title,
      theme: safeTheme(theme),
      slides,
      createdAt: new Date().toISOString(),
      userId: req.auth.userId // Associate deck with user
    };
    await saveDeck(deck);
    res.json(deckResponse(deck));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Get a specific deck by ID
app.get('/api/decks/:id', requireAuth, wrap(async (req, res) => {
  const deck = await getOwnedDeck(req, res);
  if (!deck) return;
  res.json(deckResponse(deck));
}));

// Update a specific deck by ID
app.put('/api/decks/:id', requireAuth, wrap(async (req, res) => {
  const deck = await getOwnedDeck(req, res);
  if (!deck) return;

  const { markdown, theme } = req.body || {};
  if (typeof markdown === 'string') {
    const slides = parseSlides(markdown);
    if (!slides.length) return res.status(400).json({ error: 'No slides found. Each slide needs a "## Title" line.' });
    deck.slides = slides;
    deck.title = slides[0].title;
  }
  if (typeof theme === 'string') deck.theme = safeTheme(theme);

  await saveDeck(deck);
  res.json(deckResponse(deck));
}));

// NOTE: these two exports require the Authorization header, so the browser must fetch them with
// the Clerk token (see downloadFile() in public/clerk-auth.js). A plain <a href> cannot send it.
app.get('/api/decks/:id/export.pptx', requireAuth, wrap(async (req, res) => {
  const deck = await getOwnedDeck(req, res, { text: true });
  if (!deck) return;

  try {
    const buffer = await buildPptx(deck.slides, deck.theme, deck.title);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': `attachment; filename="${slug(deck.title)}.pptx"`
    });
    res.send(buffer);
  } catch (e) {
    console.error(e);
    res.status(500).send('Could not build the PowerPoint file');
  }
}));

app.get('/api/decks/:id/export.html', requireAuth, wrap(async (req, res) => {
  const deck = await getOwnedDeck(req, res, { text: true });
  if (!deck) return;

  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Disposition': `attachment; filename="${slug(deck.title)}.html"`
  });
  res.send(renderDeckHtml(deck.slides, deck.theme, { title: deck.title }));
}));

// Shareable presentation page (also used for print-to-PDF).
// Public on purpose: the id is a random 12-character token, so the link itself is the secret.
// No auth middleware runs on this route, so the old req.auth check always failed for owned decks.
app.get('/d/:id', wrap(async (req, res) => {
  const deck = await loadDeck(req.params.id);
  if (!deck) return res.status(404).send('Deck not found');
  res.type('html').send(renderDeckHtml(deck.slides, deck.theme, { title: deck.title, id: deck.id }));
}));

// ---------- routes: S3 storage ----------
app.post('/api/s3/upload-url', requireAuth, async (req, res) => {
  const { filename, contentType } = req.body || {};
  if (!filename || !contentType) {
    return res.status(400).json({ error: 'Missing filename or contentType' });
  }

  try {
    // Generate a unique key for the file, namespaced by user
    const key = `${req.auth.userId}/${Date.now()}-${safeFilename(filename)}`;
    const url = await getPutObjectUrl(key, contentType);
    res.json({ url, key });
  } catch (e) {
    console.error('Error in S3 upload-url:', e);
    res.status(500).json({ error: 'Failed to generate upload URL', details: e.message });
  }
});

app.post('/api/s3/download-url', requireAuth, async (req, res) => {
  const { key } = req.body || {};
  if (typeof key !== 'string' || !key) {
    return res.status(400).json({ error: 'Missing key' });
  }

  // Verify the key belongs to the current user
  if (!key.startsWith(`${req.auth.userId}/`) || key.includes('..')) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const url = await getObjectUrl(key);
    res.json({ url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

app.delete('/api/s3/delete', requireAuth, async (req, res) => {
  const { key } = req.body || {};
  if (typeof key !== 'string' || !key) {
    return res.status(400).json({ error: 'Missing key' });
  }

  // Verify the key belongs to the current user
  if (!key.startsWith(`${req.auth.userId}/`) || key.includes('..')) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    await deleteObject(key);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// ---------- routes: optional ppt-master agent ----------
const jobOwners = new Map(); // jobId -> userId (in memory; cleared on restart)

app.post('/api/generate-pptx', rateLimit, requireAuth, (req, res) => {
  const { prompt } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Missing prompt' });
  }
  try {
    const jobId = startJob(prompt);
    jobOwners.set(jobId, req.auth.userId);
    res.status(202).json({ jobId, statusUrl: `/api/jobs/${jobId}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = getJob(req.params.id);
  // 404 for jobs owned by someone else so job ids cannot be probed
  if (!job || jobOwners.get(req.params.id) !== req.auth.userId) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(job);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------- start ----------
if (require.main === module) {
  // listen only after the database is ready, so early requests do not hit missing tables
  dbReady.then(() => {
    app.listen(PORT, () => {
      console.log(`ppt_slidemaker running at http://localhost:${PORT}`);
      console.log(`Model: ${MODEL}`);
      if (!process.env.CLERK_PUBLISHABLE_KEY) {
        console.warn('CLERK_PUBLISHABLE_KEY is not set: the sign-in UI cannot load.');
      }
      try {
        checkSetup();
        console.log(`ppt-master skill found at: ${SKILL_DIR}`);
      } catch (e) {
        console.log('(ppt-master skill folder not found. That is fine, only /api/generate-pptx needs it.)');
      }
    });
  });
} else {
  module.exports = app;
}