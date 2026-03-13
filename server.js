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
app.get('/manifest.json', (_req, res) => res.json({
  name: 'Palantir',
  short_name: 'Palantir',
  start_url: `https://${DOMAIN}:${PORT}/`,
  display: 'standalone',
  background_color: '#0d0d0d',
  theme_color: '#0d0d0d',
  icons: [],
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
