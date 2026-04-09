// Kromer transaction notifier.
// Primary mode: WebSocket subscription to the network `transactions` feed
// via the `kromer` package — notifications fire instantly.
// Fallback mode: HTTP polling of per-address transaction history when the
// socket drops. A `lastSeenTxId` per address lets us bridge gaps cleanly
// during fallback and catch up when the socket reconnects.

const fs = require('fs');
const path = require('path');
const { KromerApi } = require('kromer');

let notifier;
try {
  notifier = require('node-notifier');
} catch {
  notifier = null;
}

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')
);

const ICON_PATH = path.join(__dirname, 'shitty-logo.png');
const ICON = fs.existsSync(ICON_PATH) ? ICON_PATH : undefined;

const SYNC_NODE =
  config.apiBase || 'https://kromer.reconnected.cc/api/krist/';

const api = new KromerApi({
  syncNode: SYNC_NODE,
  requestTimeout: 10_000,
});

// address (lowercased) -> per-address notify flags
const watched = new Map(
  Object.entries(config.watchAddresses || {}).map(([addr, flags]) => [
    addr.toLowerCase(),
    {
      income: !!flags.income,
      paymentsOut: !!flags.paymentsOut,
      namePurchases: !!flags.namePurchases,
      nameTransfers: !!flags.nameTransfers,
    },
  ])
);

// address -> last seen transaction id (only txns with id > this are new)
const lastSeen = new Map();

// ---- Pinned-bottom TUI -------------------------------------------------

const isTTY = !!process.stdout.isTTY;
let termRows = process.stdout.rows || 24;

function ansi(s) {
  if (isTTY) process.stdout.write(s);
}

function setupRegion() {
  if (!isTTY) return;
  termRows = process.stdout.rows || 24;
  ansi(`\x1b[1;${termRows - 1}r`);
  ansi(`\x1b[${termRows - 1};1H`);
}

function teardownRegion() {
  if (!isTTY) return;
  ansi(`\x1b[r`);
  ansi(`\x1b[${termRows};1H`);
  ansi(`\x1b[2K`);
}

let mode = 'starting'; // 'ws' | 'polling' | 'reconnecting' | 'starting'
let eventsTotal = 0;
let txSeen = 0;
let nextPollAt = 0;

function drawStatus() {
  if (!isTTY) return;
  let state;
  switch (mode) {
    case 'ws':
      state = 'WS CONNECTED — live';
      break;
    case 'polling': {
      const secs = Math.max(0, Math.ceil((nextPollAt - Date.now()) / 1000));
      state = `FALLBACK POLLING — next in ${secs}s`;
      break;
    }
    case 'reconnecting':
      state = 'WS RECONNECTING…';
      break;
    default:
      state = 'starting…';
  }
  const line =
    `[watching ${watched.size} | tx seen: ${txSeen} | notifications: ${eventsTotal}] ${state}`;
  ansi('\x1b7');
  ansi(`\x1b[${termRows};1H`);
  ansi('\x1b[2K');
  process.stdout.write(line.slice(0, (process.stdout.columns || 120) - 1));
  ansi('\x1b8');
}

function log(msg) {
  const stamp = new Date().toLocaleTimeString();
  console.log(`[${stamp}] ${msg}`);
  drawStatus();
}

function notify(title, message) {
  eventsTotal++;
  log(`CHANGE — ${title}: ${message}`);
  if (notifier) {
    notifier.notify({
      title: `Kromer: ${title}`,
      message,
      icon: ICON,
      appID: 'Kromer Notifier',
    });
  }
}

// ---- Transaction classifier -------------------------------------------

function handleTxn(tx) {
  txSeen++;
  const from = (tx.from || '').toLowerCase();
  const to = (tx.to || '').toLowerCase();

  // Only emit notifications if one side matches a watched address.
  const touched = [];
  if (watched.has(from)) touched.push(from);
  if (watched.has(to) && from !== to) touched.push(to);
  if (touched.length === 0) return;

  for (const address of touched) {
    const flags = watched.get(address);

    // Advance lastSeen so fallback polling never re-emits this tx.
    const prev = lastSeen.get(address) ?? 0;
    if (tx.id > prev) lastSeen.set(address, tx.id);

    switch (tx.type) {
      case 'transfer': {
        if (to === address && flags.income) {
          const meta = tx.sent_metaname
            ? ` (to ${tx.sent_metaname}@${tx.sent_name})`
            : '';
          notify(
            'Income received',
            `${address} ${tx.value} KRO from ${tx.from}${meta}`
          );
        } else if (from === address && flags.paymentsOut) {
          const dest = tx.sent_metaname
            ? `${tx.sent_metaname}@${tx.sent_name}`
            : tx.to;
          notify('Payment sent', `${address} ${tx.value} KRO to ${dest}`);
        }
        break;
      }
      case 'name_purchase': {
        if (from === address && flags.namePurchases) {
          notify('Name purchased', `${address} bought ${tx.name}.kro`);
        }
        break;
      }
      case 'name_transfer': {
        if (from === address && flags.nameTransfers) {
          notify(
            'Name transferred away',
            `${address} sent ${tx.name}.kro to ${tx.to}`
          );
        } else if (to === address && flags.namePurchases) {
          notify(
            'Name received',
            `${address} received ${tx.name}.kro from ${tx.from}`
          );
        }
        break;
      }
      default:
        break;
    }
  }
}

// ---- Baselining & fallback polling ------------------------------------

// Fetch the newest tx id for an address to baseline lastSeen.
async function primeAddress(address) {
  try {
    const res = await api.addresses.getTransactions(address, {
      limit: 1,
      excludeMined: true,
    });
    const txns = res?.transactions || [];
    const newestId = txns.length ? txns[0].id : 0;
    lastSeen.set(address, newestId);
    log(`Primed ${address} at tx #${newestId}.`);
  } catch (err) {
    log(`[prime error ${address}] ${err.message || err}`);
    lastSeen.set(address, 0);
  }
}

// Poll one address for any txns newer than lastSeen, replay chronologically.
async function pollAddress(address) {
  const prev = lastSeen.get(address) ?? 0;
  const res = await api.addresses.getTransactions(address, {
    limit: 50,
    excludeMined: true,
  });
  const txns = (res?.transactions || [])
    .filter(t => t.id > prev)
    .sort((a, b) => a.id - b.id);

  for (const tx of txns) handleTxn(tx);
}

let pollTimer = null;

async function pollTick() {
  nextPollAt = Date.now() + config.pollIntervalMs;
  drawStatus();
  for (const address of watched.keys()) {
    try {
      await pollAddress(address);
    } catch (err) {
      log(`[poll error ${address}] ${err.message || err}`);
    }
  }
}

function startPolling() {
  if (pollTimer) return;
  mode = 'polling';
  log('Falling back to HTTP polling.');
  pollTick();
  pollTimer = setInterval(pollTick, config.pollIntervalMs);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

// ---- WebSocket management ---------------------------------------------

let ws = null;
let wsReconnectDelay = 1000; // ms, exponential backoff up to 30s
let wsShouldRun = true;

async function startWs() {
  if (!wsShouldRun) return;
  mode = 'reconnecting';
  drawStatus();

  try {
    ws = api.createWsClient(undefined, ['transactions']);

    ws.on('ready', () => {
      mode = 'ws';
      wsReconnectDelay = 1000;
      stopPolling();
      log('WebSocket connected. Catching up on any missed transactions…');
      // Catch-up poll to bridge any gap between fallback end and ws start.
      (async () => {
        for (const address of watched.keys()) {
          try {
            await pollAddress(address);
          } catch (err) {
            log(`[catchup error ${address}] ${err.message || err}`);
          }
        }
        log('Catch-up complete. Live.');
      })();
    });

    ws.on('transaction', tx => {
      handleTxn(tx);
    });

    ws.on('close', () => {
      if (!wsShouldRun) return;
      log('WebSocket closed.');
      scheduleReconnect();
    });

    ws.on('error', () => {
      // `close` will fire right after. Do nothing here to avoid double-logging.
    });

    await ws.connect();
  } catch (err) {
    log(`[ws error] ${err.message || err}`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!wsShouldRun) return;
  // Activate polling fallback immediately so the user keeps getting events.
  startPolling();
  mode = 'polling';
  const delay = wsReconnectDelay;
  wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30_000);
  log(`Reconnecting WebSocket in ${Math.round(delay / 1000)}s…`);
  setTimeout(startWs, delay);
}

// ---- Startup -----------------------------------------------------------

(async () => {
  setupRegion();
  log('Kromer notifier starting.');
  log(`Endpoint: ${SYNC_NODE}`);
  log(
    `Watching: ${watched.size ? [...watched.keys()].join(', ') : '(none — add entries to config.json)'}`
  );
  log(`Fallback poll interval: ${config.pollIntervalMs}ms`);

  if (watched.size === 0) {
    log('No addresses configured. Exiting.');
    teardownRegion();
    process.exit(0);
  }

  // Baseline every watched address so polling fallback has a starting point.
  for (const address of watched.keys()) {
    await primeAddress(address);
  }

  await startWs();
  setInterval(drawStatus, 1000);

  process.stdout.on('resize', () => {
    setupRegion();
    drawStatus();
  });

  const shutdown = () => {
    wsShouldRun = false;
    stopPolling();
    teardownRegion();
    console.log('Stopped.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})();
