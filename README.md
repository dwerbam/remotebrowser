# remotebrowser

Remote Chromium browser via CDP screencast — view and interact with a headless Chrome instance from your browser. Built-in DevTools.

## Usage

```bash
npx @dwerbam/remotebrowser --port 3000
```

Open `http://localhost:3000` — you'll see the remote browser.

Click **DevTools** in the toolbar to open Chrome DevTools for the remote page.

## How it works

CDP screencast streams JPEG frames on change (zero bandwidth when idle). Mouse/keyboard events are relayed to the remote browser. The HTTP+WS proxy exposes Chrome's DevTools protocol — `chrome://inspect` discovers targets, DevTools frontend connects through the same port.

## Requirements

Node.js 18+. Chromium is auto-downloaded on first run (~150MB, cached).
