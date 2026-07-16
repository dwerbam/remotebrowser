#!/usr/bin/env node
import { createServer, request as httpRequest } from 'http';
import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { chromium } from 'playwright';

// --port / -p (CLI > env > 3000)
let PORT = 3000;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '-p' || args[i] === '--port') && args[i+1]) PORT = parseInt(args[i+1]);
  else if (args[i].startsWith('--port=')) PORT = parseInt(args[i].split('=')[1]);
}
PORT = parseInt(process.env.PORT) || PORT;
PORT = isNaN(PORT) ? 3000 : PORT;

const CDP_PORT = 9223;
const HTML = readFileSync(new URL('./viewer.html', import.meta.url), 'utf8');

const CHROME = chromium.executablePath();

let _browser = null;

function proxyCDP(req, res) {
  const headers = { ...req.headers };
  delete headers.host;
  const proxy = httpRequest({
    hostname: '127.0.0.1', port: CDP_PORT,
    path: req.url, method: req.method, headers,
  }, (pres) => { res.writeHead(pres.statusCode, pres.headers); pres.pipe(res); });
  req.pipe(proxy);
  proxy.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
}

const server = createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
    return;
  }
  if ((req.headers.upgrade || '').toLowerCase() === 'websocket') return;
  proxyCDP(req, res);
});

const wss = new WebSocketServer({ server });

function relayWs(ws, targetUrl) {
  const cdp = new WebSocket(targetUrl);
  const buf = [];
  ws.on('message', (d) => {
    if (cdp.readyState === WebSocket.OPEN) cdp.send(d.toString());
    else buf.push(d.toString());
  });
  cdp.on('open', () => { buf.forEach((d) => cdp.send(d)); buf.length = 0; });
  cdp.on('message', (d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d.toString()); });
  ws.on('close', () => cdp.close());
  cdp.on('close', () => ws.close());
  ws.on('error', () => cdp.close());
  cdp.on('error', () => ws.close());
}

async function launchBrowser() {
  const proc = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=/tmp/cdp-profile-${Date.now()}`,
  ], { stdio: 'ignore' });

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      await new Promise((resolve, reject) => {
        httpRequest({ hostname: '127.0.0.1', port: CDP_PORT, path: '/json/version' }, (res) => {
          res.resume(); res.on('end', resolve);
        }).on('error', reject).end();
      });
      break;
    } catch {}
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  return { browser, context, page, cdp, proc };
}

wss.on('connection', async (ws, req) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (pathname !== '/') {
    relayWs(ws, `ws://127.0.0.1:${CDP_PORT}${req.url}`);
    return;
  }

  console.log('Viewer connected, launching browser...');
  let browser, cdp, proc;

  try {
    ({ browser, proc, cdp } = await launchBrowser());
    _browser = { browser, proc };

    await cdp.send('Page.enable');
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 60, maxWidth: 1280, everyNthFrame: 1,
    });

    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'frame', data, metadata }));
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });

    cdp.on('Page.frameNavigated', ({ frame }) => {
      if (ws.readyState === WebSocket.OPEN && frame.parentId == null) {
        ws.send(JSON.stringify({ type: 'url', url: frame.url }));
      }
    });

    ws.on('message', async (raw) => {
      try {
        const { method, params } = JSON.parse(raw.toString());
        const result = await cdp.send(method, params);
        ws.send(JSON.stringify({ type: 'result', id: method, result }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', method: JSON.parse(raw.toString()).method, error: err.message }));
      }
    });

    ws.on('close', () => {
      console.log('Viewer disconnected, closing browser');
      if (_browser?.browser === browser) _browser = null;
      cdp?.send('Page.stopScreencast').catch(() => {});
      browser?.close().catch(() => {});
      proc?.kill();
    });

    ws.on('error', () => {});

  } catch (err) {
    console.error('Launch failed:', err.message);
    ws.send(JSON.stringify({ type: 'error', error: err.message }));
    ws.close();
  }
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
