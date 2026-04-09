# Kromer Notifier

A small Node.js tool that watches one or more Kromer addresses and pops a desktop notification whenever something happens — incoming payments, outgoing payments, name purchases, and name transfers. Each event type can be toggled on or off independently per address.

Detection is transaction-id based (not balance-delta), so no event is ever missed or double-counted even if multiple transactions happen inside one polling window.

![icon](shitty-logo.png)

## Features

- Per-address toggles for **income**, **payments out**, **name purchases**, and **name transfers**
- Native desktop notifications via [`node-notifier`](https://www.npmjs.com/package/node-notifier) with a custom icon
- Pinned-bottom TUI with live countdown to the next poll (uses an ANSI scroll region, not `\r` hacks)
- Chronological event replay — if several transactions arrive between polls they fire in order
- First poll per address is silent (baselines the newest tx id) so you don't get spammed on startup
- Zero HTTP dependencies — uses Node 18+ built-in `fetch`

## Requirements

- **Node.js 18 or newer** (for built-in `fetch`)
- Windows, macOS, or Linux — `node-notifier` handles the platform differences

## Setup

First-time setup, from zero to running notifier:

### 1. Install Node.js

Grab the LTS build (18 or newer) from [nodejs.org](https://nodejs.org/) and install it. Open a new terminal afterwards and check:

```bash
node --version
```

You should see `v18.x.x` or higher. If not, restart your terminal or your machine so the `PATH` picks up the new install.

### 2. Get the code

```bash
git clone <this-repo-url>
cd krawlet-notifcation-using-api
```

Or just download the folder as a ZIP and extract it.

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

Then open [`config.json`](config.json) in any editor and replace the example addresses (`kexampleaa`, `kexamplebb`) with the Kromer addresses you actually want to watch. For each address, set the four notification flags to `true` or `false` depending on what you want to be alerted about. See the [Configuration](#configuration) section below for what each flag means.

A minimal config watching a single address for everything looks like:

```json
{
  "apiKey": "",
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

```bash
npm install
```

This pulls down `node-notifier` (the only runtime dependency) into `node_modules/`.

### 5. Run it

```bash
npm start
```

Or on Windows, just double-click [`run.bat`](run.bat) — it checks dependencies, installs them if needed, and launches the notifier in one step.

The first poll is silent per address (it baselines the newest transaction id so you don't get spammed with historical events). From that point on, any new transaction matching your enabled flags will pop a desktop notification.

To stop the program, press **Ctrl+C**. The terminal scroll region is restored cleanly on exit.

## Configuration

Edit [`config.json`](config.json):

```json
{
  "apiKey": "",
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
| `apiKey` | Currently unused by the public endpoints, reserved for future auth. Leave blank. |
| `apiBase` | *(optional)* Override the Kromer node base URL. Defaults to `https://kromer.reconnected.cc/api/krist`. |
| `pollIntervalMs` | How often to poll each address, in milliseconds. `120000` = 2 minutes. |
| `watchAddresses` | Object map where each key is a Kromer address and the value is its per-address notification flags. Copy-paste a block and change the key to add more addresses. |

### Notification flags

| Flag | Fires when… |
|------|-------------|
| `income` | A `transfer` transaction is received by the address |
| `paymentsOut` | A `transfer` transaction is sent by the address |
| `namePurchases` | The address purchases a `.kro` name, or receives one via `name_transfer` |
| `nameTransfers` | The address sends a `.kro` name to someone else |

## Running

```bash
npm start
```

or

```bash
node index.js
```

or on Windows: double-click [`run.bat`](run.bat).

You'll see something like:

```
[10:42:01] Kromer notifier starting.
[10:42:01] Endpoint: https://kromer.reconnected.cc/api/krist
[10:42:01] Watching: kcasino6vr, kvillwkw05
[10:42:01] Interval: 120000ms
[10:42:02] Polling Kromer API…
[10:42:02] Primed kcasino6vr at tx #40033.
[10:42:02] Primed kvillwkw05 at tx #39817.
[watching 2 | polls: 1 | changes: 0] next poll in 119s
```

The bottom line is pinned — logs scroll above it.

Press **Ctrl+C** to stop. The scroll region is restored cleanly on exit.

## How it works

1. On startup the tool loads [`config.json`](config.json) and builds a map of watched addresses and their per-address flags.
2. Every `pollIntervalMs`, for each watched address, it fetches the most recent transactions from `GET /addresses/{address}/transactions?limit=25&excludeMined=true`.
3. The first poll per address just records the newest transaction id as a baseline — no notifications.
4. On subsequent polls, any transaction with an id greater than the recorded baseline is "new". New transactions are sorted oldest-first and classified by `tx.type`:
   - `transfer` → **income** or **paymentsOut** depending on direction
   - `name_purchase` → **namePurchases** (if the address is the buyer)
   - `name_transfer` → **nameTransfers** (outgoing) or **namePurchases** (incoming)
5. Each matching event, if enabled in config, fires a desktop notification and a log line. The baseline id is then advanced to the newest id.

This is the same approach Krist bots use and is reliable across arbitrarily busy polling windows.

## Files

| File | Purpose |
|------|---------|
| [`index.js`](index.js) | Main entrypoint — polling loop, classifier, and TUI |
| [`config.json`](config.json) | Your watched addresses and notification preferences |
| [`package.json`](package.json) | Dependencies and npm scripts |
| [`run.bat`](run.bat) | Windows one-click installer + launcher |
| [`shitty-logo.png`](shitty-logo.png) | Icon used in desktop notifications |
| [`.gitignore`](.gitignore) | Excludes `node_modules/` and `config.json` (keeps secrets out of git) |

## Notes & caveats

- `config.json` is in `.gitignore` — your addresses and any future API key will not be committed. Don't remove it.
- The default polling interval of 2 minutes means an event could take up to ~2 minutes to notify you. Lower `pollIntervalMs` if you want faster detection; the Kromer node is public so be reasonable.
- "Mined" transactions are excluded from polling via `excludeMined=true` because they're typically not interesting noise.
- Only `transfer`, `name_purchase`, and `name_transfer` transaction types are classified. Other types (e.g. `name_a_record`) are silently ignored.

## License

MIT — do whatever you want.
