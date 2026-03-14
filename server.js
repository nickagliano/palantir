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

// Generate a solid-color PNG (no dependencies)
function solidPng(hex, size = 180) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

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

  const row = Buffer.allocUnsafe(1 + size * 3);
  row[0] = 0;
  for (let x = 0; x < size; x++) { row[1 + x*3] = r; row[2 + x*3] = g; row[3 + x*3] = b; }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const iconPng = solidPng('#c9a84c');

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

const app = express();
const server = https.createServer(tlsOptions, app);
const wss = new WebSocketServer({
  server,
  verifyClient: ({ req }) => {
    const token = new URL(req.url, 'https://localhost').searchParams.get('token');
    return token === TOKEN;
  },
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/palette.json', (_req, res) => res.sendFile(path.join(__dirname, 'palette.json')));
app.get('/apple-touch-icon.png', (_req, res) => {
  res.set('Content-Type', 'image/png').send(iconPng);
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

  clientWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'resize') {
        cols = msg.cols; rows = msg.rows;
        stream?.setWindow(rows, cols, 0, 0);
      } else if (msg.type === 'data') {
        if (stream) stream.write(msg.data);
        else pending.push(msg.data);
      }
    } catch { /* ignore */ }
  });

  ssh.on('ready', () => {
    console.log('ssh ready, attaching tmux');
    ssh.exec("LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 TERM=xterm-256color /usr/local/bin/tmux -u new-session -A -s pal", { pty: { term: 'xterm-256color', cols, rows }, env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } }, (err, sh) => {
      if (err) {
        console.error('shell error:', err.message);
        clientWs.send('\r\n\x1b[31m[shell failed: ' + err.message + ']\x1b[0m\r\n');
        clientWs.close();
        return;
      }

      stream = sh;

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
