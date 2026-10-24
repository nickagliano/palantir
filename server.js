// Load .env
try {
  require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8')
    .split('\n').forEach(line => {
      const [k, ...v] = line.split('=');
      if (k && v.length) process.env[k.trim()] = v.join('=').trim();
    });
} catch {}

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFile } = require('child_process');

// Generate a solid-color PNG (no dependencies)
function solidPng(hex, letter = null, fgHex = '#1a1a1a', size = 180) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const fr = parseInt(fgHex.slice(1, 3), 16);
  const fg = parseInt(fgHex.slice(3, 5), 16);
  const fb = parseInt(fgHex.slice(5, 7), 16);

  // Fill the canvas with the background color (one RGB triple per pixel).
  const px = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    px[i * 3] = r; px[i * 3 + 1] = g; px[i * 3 + 2] = b;
  }
  const paintRect = (x1, y1, x2, y2) => {
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        const i = (y * size + x) * 3;
        px[i] = fr; px[i + 1] = fg; px[i + 2] = fb;
      }
    }
  };
  // Rectangle-stroke glyphs at 180x180. Add more letters as more apps want them.
  const glyphs = {
    P: () => {
      // 25-px-thick strokes; bowl hole is 65×25 around the middle of the upper half.
      paintRect(40, 25, 65, 155);   // left stem (full height)
      paintRect(40, 25, 155, 50);   // top of bowl
      paintRect(130, 25, 155, 100); // right of bowl
      paintRect(40, 75, 155, 100);  // bottom of bowl
    },
  };
  if (letter && glyphs[letter]) glyphs[letter]();

  // EPM family wrapper: viewfinder-style corner ticks. Same fg color as the letter.
  // 14px inset, 20px long, 4px thick — present on every EPM app icon.
  const tick = (x1, y1, x2, y2) => paintRect(x1, y1, x2, y2);
  tick(14, 14, 34, 18); tick(14, 14, 18, 34);     // top-left
  tick(146, 14, 166, 18); tick(162, 14, 166, 34); // top-right
  tick(14, 162, 34, 166); tick(14, 146, 18, 166); // bottom-left
  tick(146, 162, 166, 166); tick(162, 146, 166, 166); // bottom-right

  // CRC32 table
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[i] = c;
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const typeB = Buffer.from(type);
    const lenB = Buffer.allocUnsafe(4); lenB.writeUInt32BE(data.length);
    const crcB = Buffer.allocUnsafe(4); crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
    return Buffer.concat([lenB, typeB, data, crcB]);
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Build PNG scanlines: filter byte 0 + one row of RGB triples per line.
  const rowBytes = size * 3;
  const raw = Buffer.alloc((rowBytes + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (rowBytes + 1)] = 0;
    px.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const iconPng = solidPng('#c9a84c', 'P');

const SESSION_FILE = path.join(__dirname, 'session');
function readSavedSession() {
  try { return fs.readFileSync(SESSION_FILE, 'utf8').trim() || null; } catch { return null; }
}
function saveSession(name) {
  try { fs.writeFileSync(SESSION_FILE, name, 'utf8'); } catch (e) { console.error('failed to save session:', e.message); }
}
let currentSession = readSavedSession() || process.env.PALANTIR_SESSION || 'eps';

const TOKEN = process.env.PALANTIR_TOKEN;
if (!TOKEN) { console.error('PALANTIR_TOKEN not set — refusing to start'); process.exit(1); }

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '4444');
const SSH_KEY = path.join(os.homedir(), '.ssh', 'palantir_key');
const SSH_USER = os.userInfo().username;
const DOMAIN = process.env.DOMAIN;
if (!DOMAIN) { console.error('DOMAIN not set — refusing to start'); process.exit(1); }
const tlsOptions = {
  cert: fs.readFileSync(path.join(__dirname, `${DOMAIN}.crt`)),
  key:  fs.readFileSync(path.join(__dirname, `${DOMAIN}.key`)),
};

// Per-IP brute-force tracking with Fibonacci lockout
const loginState = new Map(); // ip -> { failures, lockedUntil, fibA, fibB }

function getState(ip) {
  return loginState.get(ip) || { failures: 0, lockedUntil: 0, fibA: 1, fibB: 1 };
}

function recordFailure(ip) {
  const s = getState(ip);
  s.failures++;
  if (s.failures >= 3) {
    const wait = s.fibA;
    [s.fibA, s.fibB] = [s.fibB, s.fibA + s.fibB];
    s.lockedUntil = Date.now() + wait * 1000;
    s.failures = 0;
  }
  loginState.set(ip, s);
}

function recordSuccess(ip) { loginState.delete(ip); }

const app = express();
const server = https.createServer(tlsOptions, app);
const wss = new WebSocketServer({
  server,
  verifyClient: ({ req }, cb) => {
    const ip = req.socket.remoteAddress;
    const s = getState(ip);
    if (Date.now() < s.lockedUntil) { cb(false, 429, 'Too Many Attempts'); return; }
    const token = new URL(req.url, 'https://localhost').searchParams.get('token');
    if (token === TOKEN) { recordSuccess(ip); cb(true); }
    else { recordFailure(ip); cb(false, 401, 'Unauthorized'); }
  },
});

app.use(express.static(path.join(__dirname, 'public'), { etag: false, setHeaders: (res, filePath) => {
  if (filePath.endsWith('index.html')) res.set('Cache-Control', 'no-store');
}}));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/palette.json', (_req, res) => res.sendFile(path.join(__dirname, 'palette.json')));
app.get('/apple-touch-icon.png', (_req, res) => {
  res.set('Content-Type', 'image/png').send(iconPng);
});
function requireToken(req, res, next) {
  const token = req.query.token || req.headers['x-palantir-token'];
  if (token === TOKEN) next();
  else res.status(401).json({ error: 'Unauthorized' });
}

function listTmuxSessions(cb) {
  execFile('/usr/local/bin/tmux', ['list-sessions', '-F', '#{session_name}'], (err, stdout) => {
    cb(err ? [] : stdout.trim().split('\n').filter(Boolean));
  });
}

app.get('/api/session', requireToken, (_req, res) => res.json({ session: currentSession }));

app.get('/api/sessions', requireToken, (_req, res) => {
  listTmuxSessions(sessions => res.json({ sessions, current: currentSession }));
});

app.post('/api/session', requireToken, express.json(), (req, res) => {
  const { session } = req.body || {};
  if (!session || typeof session !== 'string' || !/^[a-zA-Z0-9_\-.]+$/.test(session)) {
    return res.status(400).json({ error: 'Invalid session name' });
  }
  currentSession = session;
  saveSession(session);
  console.log('session switched to:', currentSession);
  res.json({ session: currentSession });
});

app.get('/manifest.json', (_req, res) => res.json({
  name: 'Palantir',
  short_name: 'Palantir',
  start_url: `https://${DOMAIN}:${PORT}/`,
  display: 'standalone',
  background_color: '#0d0d0d',
  theme_color: '#0d0d0d',
  icons: [
    { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }
  ],
}));

wss.on('connection', (clientWs) => {
  console.log('browser connected');

  const ssh = new Client();
  let stream = null;
  let cols = 220, rows = 50;
  const pending = [];

  // SIGWINCH alone isn't enough. If the browser and tmux disagree about the
  // geometry even briefly, tmux repaints assuming the old size and leaves
  // stale rows on screen — duplicated status lines that survive until you
  // reattach. Once a resize settles, tell tmux to repaint from scratch.
  let redrawTimer = null;
  function scheduleRedraw() {
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => {
      execFile('/usr/local/bin/tmux', ['list-clients', '-t', currentSession, '-F', '#{client_name}'], (err, out) => {
        if (err) return;
        out.trim().split('\n').filter(Boolean).forEach(name =>
          execFile('/usr/local/bin/tmux', ['refresh-client', '-t', name], () => {}));
      });
    }, 250);
  }

  clientWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'resize') {
        // Ignore bogus geometry — the client can briefly compute 0 cols while
        // the iOS keyboard animates, and a 0-wide pty wedges tmux.
        const c = Math.floor(msg.cols), r = Math.floor(msg.rows);
        if (!(c > 0 && r > 0)) return;
        cols = c; rows = r;
        // May be a no-op if the shell isn't up yet; the exec callback below
        // re-applies the latest size once the stream exists.
        stream?.setWindow(rows, cols, 0, 0);
        scheduleRedraw();
      } else if (msg.type === 'data') {
        if (stream) stream.write(msg.data);
        else pending.push(msg.data);
      }
    } catch { /* ignore */ }
  });

  ssh.on('ready', () => {
    console.log('ssh ready, attaching tmux');
    saveSession(currentSession);
    ssh.exec(`LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 TERM=xterm-256color /usr/local/bin/tmux -u new-session -A -s ${currentSession}`, { pty: { term: 'xterm-256color', cols, rows }, env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } }, (err, sh) => {
      if (err) {
        console.error('shell error:', err.message);
        clientWs.send('\r\n\x1b[31m[shell failed: ' + err.message + ']\x1b[0m\r\n');
        clientWs.close();
        return;
      }

      stream = sh;

      // ssh.exec() captured cols/rows as they were when the request went out,
      // and any resize that landed while the channel was opening hit a null
      // `stream` and was dropped. Since we connect to 127.0.0.1, ssh is often
      // ready before the browser's first resize arrives, so the pty would keep
      // the 220x50 default while the phone is ~100 cols wide. tmux then draws
      // status lines wider than the viewport, they wrap, and every redraw
      // pushes a duplicate down the screen. Re-apply the latest size here.
      stream.setWindow(rows, cols, 0, 0);
      console.log(`pty attached at ${cols}x${rows}`);
      scheduleRedraw();

      // Drain any input that arrived before the shell was ready
      pending.forEach(d => stream.write(d));
      pending.length = 0;

      sh.on('data', (data) => {
        if (clientWs.readyState === clientWs.OPEN)
          clientWs.send(data);
      });

      sh.stderr.on('data', (data) => {
        if (clientWs.readyState === clientWs.OPEN)
          clientWs.send(data);
      });

      sh.on('close', () => {
        console.log('shell closed');
        if (clientWs.readyState === clientWs.OPEN) clientWs.close();
        ssh.end();
      });
    });
  });

  ssh.on('error', (err) => {
    console.error('ssh error:', err.message);
    if (clientWs.readyState === clientWs.OPEN) {
      clientWs.send('\r\n\x1b[31m[ssh error: ' + err.message + ']\x1b[0m\r\n');
      clientWs.close();
    }
  });

  clientWs.on('close', () => {
    console.log('browser disconnected');
    clearTimeout(redrawTimer);
    stream?.close();
    ssh.end();
  });

  ssh.connect({
    host: '127.0.0.1',
    port: 22,
    username: SSH_USER,
    privateKey: fs.readFileSync(SSH_KEY),
  });
});

server.listen(PORT, HOST, () => {
  console.log(`palantir running at http://${HOST}:${PORT}`);
  console.log(`ssh user: ${SSH_USER}, key: ${SSH_KEY}`);
});
