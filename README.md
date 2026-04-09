# Kromer Notifier

A desktop notifier for [Kromer](https://kromer.reconnected.cc) — the currency system used by Reconnected.CC. Watches one or more Kromer addresses and pops a native notification whenever something happens: incoming payments, outgoing payments, name purchases, and name transfers. Every event type can be toggled on or off independently **per address**.

Comes in two flavours — **Node.js** and **Python** — that behave identically. Pick whichever you prefer, or build the Python version into a standalone Windows `.exe`.

![icon](shitty-logo.png)

## Features

- **Real-time via WebSocket.** Subscribes to the Kromer network transaction feed and fires notifications the instant a transaction touches a watched address. No 2-minute polling delay.
- **HTTP polling fallback.** If the socket drops, the notifier automatically falls back to polling the REST API until the socket reconnects — no events missed.
- **Seamless handoff.** A per-address `lastSeenTxId` bridges the gap between the two modes. Every event fires exactly once.
- **Per-address notification toggles** for `income`, `paymentsOut`, `namePurchases`, and `nameTransfers`.
- **Pinned-bottom TUI** with live connection status and a highlighted `Ctrl+X` control hint (uses an ANSI scroll region, not `\r` hacks).
- **Ctrl+X → save & quit.** On Ctrl+X, the notifier fetches each watched address's current balance and writes an `end.balance.json` snapshot so you can diff later and spot transactions that happened while it was offline.
- **Native desktop notifications** with a custom icon (`node-notifier` on Node, `winotify` on Python/Windows).
- **Chronological replay** — if several transactions arrive between polls (fallback mode) they fire in order.
- **First poll per address is silent** so you aren't spammed with historical events on startup.

## Requirements

Pick one of:

- **Node.js 18+** (for built-in `fetch`), or
- **Python 3.10+** (for the Python port and/or `.exe` build).

Works on Windows, macOS, and Linux. Desktop notifications are best-supported on Windows.

## Setup

### 1. Install a runtime

- **Node** — grab the LTS build from [nodejs.org](https://nodejs.org/) and check `node --version` shows `v18.x.x` or higher.
- **Python** — grab 3.10 or newer from [python.org](https://www.python.org/) and check `python --version`.

### 2. Get the code

```bash
git clone <this-repo-url>
cd krawlet-notifcation-using-api
```

…or download the folder as a ZIP and extract it.

### 3. Create your config

The real config file is gitignored so your addresses stay private. Copy the template:

**Windows (PowerShell or CMD):**
```bash
copy config.template.json config.json
```

**macOS / Linux:**
```bash
cp config.template.json config.json
```

Then open [`config.json`](config.json) and replace the example address with the Kromer addresses you actually want to watch. For each address, set the four notification flags to `true` or `false`. See [Configuration](#configuration) below for what each flag means.

A minimal config watching a single address for everything:

```json
{
  "apiBase": "https://kromer.reconnected.cc/api/krist/",
  "pollIntervalMs": 120000,
  "watchAddresses": {
    "kyouraddress": {
      "income": true,
      "paymentsOut": true,
      "namePurchases": true,
      "nameTransfers": true
    }
  }
}
```

### 4. Install dependencies

**Node:**
```bash
npm install
```

**Python:**
```bash
pip install -r requirements.txt
```

## Running

### Node

```bash
npm start
```

…or on Windows, double-click [`run.bat`](run.bat) — it checks dependencies, installs them if needed, and launches the notifier in one step.

### Python

```bash
python main.py
```

### Windows `.exe` (PyInstaller)

Double-click [`build_exe.bat`](build_exe.bat). It will:

1. `pip install` the requirements + `pyinstaller`
2. Bundle [`main.py`](main.py) + [`shitty-logo.png`](shitty-logo.png) into `dist/kromer-notifier.exe`
3. Copy [`config.template.json`](config.template.json) → `dist/config.json` if missing
4. Copy [`shitty-logo.png`](shitty-logo.png) next to the exe

Then fill in `dist/config.json` with your addresses and run `dist\kromer-notifier.exe`.

The exe uses [`shitty-logo.ico`](shitty-logo.ico) as the window/taskbar icon — that file is already committed so the build works out of the box.

### What you'll see

```
[10:42:01] Kromer notifier starting.
[10:42:01] Endpoint: https://kromer.reconnected.cc/api/krist/
[10:42:01] Watching: kcasino6vr, kvillwkw05
[10:42:01] Fallback poll interval: 120000ms
[10:42:02] Primed kcasino6vr at tx #40033.
[10:42:02] Primed kvillwkw05 at tx #39817.
[10:42:02] WebSocket connected. Catching up on any missed transactions…
[10:42:02] Catch-up complete. Live.
[watching 2 | tx seen: 0 | notifications: 0] WS CONNECTED — live    Ctrl+X  save & quit
```

The bottom line is pinned — log messages scroll above it.

## Controls

| Key     | Action |
|---------|--------|
| **Ctrl+X** | Fetch current balances for every watched address, write `end.balance.json`, and exit cleanly. Use this when shutting down if you want a snapshot to diff against later. |
| **Ctrl+C** | Immediate quit — **does not** save a balance snapshot. |

`end.balance.json` looks like:

```json
{
  "endedAt": "2026-04-08T23:14:02.114Z",
  "endpoint": "https://kromer.reconnected.cc/api/krist/",
  "addresses": {
    "kcasino6vr": {
      "balance": 3104.40002,
      "totalin": 882.23,
      "totalout": 879.20,
      "lastSeenTxId": 40033
    }
  }
}
```

`lastSeenTxId` is the id of the newest transaction the notifier had processed at the moment you hit Ctrl+X. Next time you start up, you can compare that to the current newest tx id for each address to see exactly which transactions happened while it was offline.

## Configuration

Edit [`config.json`](config.json):

```json
{
  "apiBase": "https://kromer.reconnected.cc/api/krist/",
  "pollIntervalMs": 120000,
  "watchAddresses": {
    "kcasino6vr": {
      "income": true,
      "paymentsOut": true,
      "namePurchases": false,
      "nameTransfers": true
    },
    "kvillwkw05": {
      "income": true,
      "paymentsOut": false,
      "namePurchases": false,
      "nameTransfers": false
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `apiBase` | *(optional)* Base URL of the Kromer node. Defaults to `https://kromer.reconnected.cc/api/krist/`. |
| `pollIntervalMs` | How often to poll each address **in fallback mode**, in milliseconds. `120000` = 2 minutes. Ignored while the WebSocket is connected. |
| `watchAddresses` | Object map. Each key is a Kromer address; each value is that address's per-address notification flags. Copy-paste an entry and change the key to watch another address. |

### Notification flags

| Flag | Fires when… |
|------|-------------|
| `income` | A `transfer` transaction is received by the address |
| `paymentsOut` | A `transfer` transaction is sent by the address |
| `namePurchases` | The address buys a `.kro` name, or receives one via `name_transfer` |
| `nameTransfers` | The address sends a `.kro` name to someone else |

## How it works

1. **Baseline.** On startup, the tool fetches the newest transaction id for each watched address and records it so the first run is silent.
2. **WebSocket primary mode.** It opens a WebSocket to the Kromer sync node, subscribes to the network `transactions` feed, and classifies every incoming event. Transactions that don't touch a watched address are filtered out locally. Notifications fire instantly.
3. **Fallback polling.** If the socket drops, the notifier switches to polling `GET /addresses/{addr}/transactions` for each watched address every `pollIntervalMs`. New transactions (`id > lastSeenTxId`) are replayed oldest-first.
4. **Reconnect with backoff.** The WebSocket is retried with exponential backoff (1s → 2s → 4s → … capped at 30s). On successful reconnect, a one-shot catch-up poll bridges any gap, then polling stops and the WebSocket takes over.
5. **No duplicates, no gaps.** The per-address `lastSeenTxId` is updated in both modes, so handing off between WS and polling never misses or double-emits an event.

## Files

| File | Purpose |
|------|---------|
| [`index.js`](index.js) | Node.js entrypoint |
| [`main.py`](main.py) | Python entrypoint (identical behaviour) |
| [`config.template.json`](config.template.json) | Committed example config — copy to `config.json` to get started |
| `config.json` | *(gitignored)* Your real config |
| `end.balance.json` | *(gitignored)* Balance snapshot written on Ctrl+X |
| [`package.json`](package.json) | Node dependencies and scripts |
| [`requirements.txt`](requirements.txt) | Python dependencies |
| [`run.bat`](run.bat) | Windows one-click install + run for the Node version |
| [`build_exe.bat`](build_exe.bat) | Windows PyInstaller build script for the Python version |
| [`shitty-logo.png`](shitty-logo.png) | Notification icon |
| [`shitty-logo.ico`](shitty-logo.ico) | Windows exe icon |
| [`.gitignore`](.gitignore) | Keeps secrets, caches, and build artifacts out of git |

## Notes & caveats

- `config.json` and `end.balance.json` are in `.gitignore` so your private data stays out of the repo — don't remove those lines.
- The default fallback poll interval of 2 minutes only matters when the WebSocket is down. While the WS is connected, notifications are real-time.
- Only `transfer`, `name_purchase`, and `name_transfer` transaction types are classified. Other types (`name_a_record`, `mined`, etc.) are ignored.
- The WebSocket is subscribed in **guest mode** (no private key) — this gives you the public network-wide `transactions` feed, which is perfectly sufficient for watching addresses you don't own.
- If you run in a non-TTY environment (piping to a file, CI, etc.) the TUI degrades gracefully to plain line-by-line logging.

## License

MIT — do whatever you want.
