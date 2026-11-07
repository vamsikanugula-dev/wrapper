/**
 * pptAgent.js
 * Minimal agent loop: gives an OpenRouter model (e.g. Nemotron 3 Ultra) a few
 * sandboxed tools and the ppt-master SKILL.md, so the model can follow the
 * skill's workflow and produce a real .pptx file.
 *
 * Requirements: Node >= 18, Python installed, and the ppt-master repo cloned
 * (so that SKILL_DIR contains SKILL.md, workflows/, scripts/ ...).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ---------- config ----------
const MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';
const SKILL_DIR = path.resolve(
  process.env.SKILL_DIR || path.join(__dirname, 'ppt-master', 'skills', 'ppt-master')
);
const WORKSPACE_ROOT = path.resolve(__dirname, 'workspace');
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 60);
const MAX_TOOL_OUTPUT = 20000; // chars returned to the model per tool call

const jobs = new Map();

// ---------- setup check ----------
function checkSetup() {
  if (!fs.existsSync(path.join(SKILL_DIR, 'SKILL.md'))) {
    throw new Error(
      `SKILL.md not found in SKILL_DIR (${SKILL_DIR}). Clone the ppt-master repo or set SKILL_DIR in .env`
    );
  }
}

// ---------- path helpers (sandbox) ----------
function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function expandVars(s, ws) {
  return String(s).replace(/\$\{SKILL_DIR\}/g, SKILL_DIR).replace(/\$\{WORKSPACE\}/g, ws);
}

function resolveReadable(p, ws) {
  const abs = path.resolve(ws, expandVars(p, ws));
  if (isInside(SKILL_DIR, abs) || isInside(ws, abs)) return abs;
  throw new Error('Path not allowed (must be inside SKILL_DIR or WORKSPACE)');
}

function resolveWritable(p, ws) {
  const abs = path.resolve(ws, expandVars(p, ws));
  if (isInside(ws, abs)) return abs;
  throw new Error('Path not allowed (must be inside WORKSPACE)');
}

function truncate(s) {
  s = String(s);
  return s.length > MAX_TOOL_OUTPUT ? s.slice(0, MAX_TOOL_OUTPUT) + '\n...[truncated]' : s;
}

// ---------- tools ----------
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file inside SKILL_DIR or WORKSPACE.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files in a directory inside SKILL_DIR or WORKSPACE.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a text file inside WORKSPACE (creates folders as needed).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_python',
      description:
        'Run a Python script that lives inside SKILL_DIR. Working directory is WORKSPACE. ' +
        'Use ${SKILL_DIR} and ${WORKSPACE} in paths if you like.',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'Path to a .py file inside SKILL_DIR' },
          args: { type: 'array', items: { type: 'string' } }
        },
        required: ['script']
      }
    }
  }
];

function runPython(script, args, ws) {
  return new Promise((resolve, reject) => {
    const abs = path.resolve(ws, expandVars(script, ws));
    if (!isInside(SKILL_DIR, abs) || !abs.endsWith('.py')) {
      return reject(new Error('Only .py scripts inside SKILL_DIR may be run'));
    }
    const argv = [abs, ...(args || []).map(a => expandVars(a, ws))];
    execFile(
      PYTHON_BIN,
      argv,
      { cwd: ws, timeout: 300000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve(`exit_code: ${code}\nstdout:\n${stdout}\nstderr:\n${stderr || (err ? err.message : '')}`);
      }
    );
  });
}

async function runTool(name, args, ws) {
  switch (name) {
    case 'read_file':
      return truncate(fs.readFileSync(resolveReadable(args.path, ws), 'utf8'));
    case 'list_dir': {
      const dir = resolveReadable(args.path || '.', ws);
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .map(d => (d.isDirectory() ? d.name + '/' : d.name))
        .join('\n');
    }
    case 'write_file': {
      const abs = resolveWritable(args.path, ws);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, args.content ?? '', 'utf8');
      return `Wrote ${abs}`;
    }
    case 'run_python':
      return truncate(await runPython(args.script, args.args, ws));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------- model call ----------
async function callModel(messages) {
  const body = { model: MODEL, messages, tools: TOOLS, temperature: 0.3, max_tokens: 8192 };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'ppt-slidemaker'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000)
    });

    if (res.ok) {
      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('No message in model response: ' + JSON.stringify(data).slice(0, 500));
      return msg;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise(r => setTimeout(r, 4000 * attempt));
      continue;
    }
    throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`);
  }
}

// ---------- agent loop ----------
async function runAgent(job) {
  const ws = job.workspace;
  const skillMd = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');

  const system = [
    'You are an agent that executes the "ppt-master" skill to build an editable PPTX deck.',
    `SKILL_DIR = ${SKILL_DIR}`,
    `WORKSPACE = ${ws}  (all outputs, including the final .pptx, must be saved here)`,
    '',
    'Tools: read_file, list_dir, write_file, run_python. There is no shell: run Python scripts with run_python.',
    'When the skill says `python3 "${SKILL_DIR}/scripts/x.py" args`, call run_python with script and args.',
    '',
    'There is NO interactive user. Treat the request as an explicit Quick generation, and treat every',
    'BLOCKING gate as already confirmed with sensible defaults. Do not ask the user questions.',
    'Follow the skill load order: run attribution_guard.py first, then read workflows/routing.md, then only the',
    'selected runtime authority. When finished, reply with a short summary and the path of the final .pptx.',
    '',
    '===== SKILL.md =====',
    skillMd
  ].join('\n');

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: job.prompt }
  ];

  for (let step = 1; step <= MAX_STEPS; step++) {
    const msg = await callModel(messages);
    const calls = msg.tool_calls || [];

    messages.push({
      role: 'assistant',
      content: msg.content ?? '',
      ...(calls.length ? { tool_calls: calls } : {})
    });

    if (!calls.length) {
      job.summary = msg.content || '';
      return;
    }

    for (const tc of calls) {
      let result;
      try {
        const args = JSON.parse(tc.function.arguments || '{}');
        job.log.push(`step ${step}: ${tc.function.name} ${JSON.stringify(args).slice(0, 200)}`);
        result = await runTool(tc.function.name, args, ws);
      } catch (e) {
        result = `ERROR: ${e.message}`;
        job.log.push(`step ${step}: tool error: ${e.message}`);
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: truncate(result) });
    }
  }
  throw new Error(`Agent stopped after ${MAX_STEPS} steps without finishing`);
}

// ---------- jobs ----------
function collectPptx(dir, base = dir, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) collectPptx(full, base, out);
    else if (d.name.toLowerCase().endsWith('.pptx')) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

function startJob(prompt) {
  checkSetup();
  const id = crypto.randomBytes(6).toString('hex');
  const workspace = path.join(WORKSPACE_ROOT, id);
  fs.mkdirSync(workspace, { recursive: true });

  const job = { id, prompt, workspace, status: 'running', log: [], summary: '', files: [], error: null };
  jobs.set(id, job);

  runAgent(job)
    .then(() => {
      job.files = collectPptx(workspace).map(rel => `/files/${id}/${rel}`);
      job.status = job.files.length ? 'done' : 'finished_without_pptx';
    })
    .catch(e => {
      console.error(e);
      job.error = e.message;
      job.status = 'error';
    });

  return id;
}

function getJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return {
    id: j.id,
    status: j.status,
    error: j.error,
    summary: j.summary,
    files: j.files,
    log: j.log.slice(-50)
  };
}

module.exports = { startJob, getJob, checkSetup, WORKSPACE_ROOT, SKILL_DIR };