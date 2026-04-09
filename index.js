// Kromer transaction notifier.
// Polls the Kromer (Krist-compatible) node at kromer.reconnected.cc and
// notifies on new transactions for the watched addresses defined in
// config.json. Detection is transaction-id based, so no event is ever
// missed or double-counted.

const fs = require('fs');
const path = require('path');

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

const API_BASE =
  (config.apiBase || 'https://kromer.reconnected.cc/api/krist').replace(/\/$/, '');

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
// Uses a DEC scroll region: rows 1..(H-1) scroll normally, row H is a
// reserved status line. Logs go through console.log and scroll above it.

const isTTY = !!process.stdout.isTTY;
let termRows = process.stdout.rows || 24;

function ansi(s) {
  if (isTTY) process.stdout.write(s);
}

function setupRegion() {
  if (!isTTY) return;
  termRows = process.stdout.rows || 24;
  // Set scroll region to rows 1..(termRows-1)
  ansi(`\x1b[1;${termRows - 1}r`);
  // Park cursor just above the status line
  ansi(`\x1b[${termRows - 1};1H`);
}

function teardownRegion() {
  if (!isTTY) return;
  // Reset scroll region, clear status line, move cursor to bottom
  ansi(`\x1b[r`);
  ansi(`\x1b[${termRows};1H`);
  ansi(`\x1b[2K`);
}

let pollsDone = 0;
let changesDetected = 0;
let nextPollAt = Date.now();
let polling = false;

function drawStatus() {
  if (!isTTY) return;
  const remainingMs = Math.max(0, nextPollAt - Date.now());
  const secs = Math.ceil(remainingMs / 1000);
  const state = polling ? 'POLLING…' : `next poll in ${secs}s`;
  const line =
    `[watching ${watched.size} | polls: ${pollsDone} | changes: ${changesDetected}] ${state}`;
  // Save cursor, move to bottom row, clear, write, restore
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
  changesDetected++;
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

// ---- API ---------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// Fetch recent transactions for an address, newest first.
async function fetchRecentTxns(address, limit = 25) {
  const data = await fetchJson(
    `${API_BASE}/addresses/${encodeURIComponent(address)}/transactions?limit=${limit}&excludeMined=true`
  );
  // Krist returns { ok, total, transactions: [...] }, typically oldest-first.
  // Sort descending by id so index 0 is newest.
  const txns = Array.isArray(data.transactions) ? data.transactions.slice() : [];
  txns.sort((a, b) => b.id - a.id);
  return txns;
}

// Classify and emit notifications for a single new transaction.
function handleTxn(address, flags, tx) {
  const from = (tx.from || '').toLowerCase();
  const to = (tx.to || '').toLowerCase();

  switch (tx.type) {
    case 'transfer': {
      if (to === address && flags.income) {
        const meta = tx.sent_metaname
          ? ` (to ${tx.sent_metaname}@${tx.sent_name})`
          : '';
        notify(
          'Income received',
          `${address} +${tx.value} KRO from ${tx.from}${meta}`
        );
      } else if (from === address && flags.paymentsOut) {
        const dest = tx.sent_metaname
          ? `${tx.sent_metaname}@${tx.sent_name}`
          : tx.to;
        notify('Payment sent', `${address} -${tx.value} KRO to ${dest}`);
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
      // name_a_record, mined, etc. — ignore
      break;
  }
}

// ---- Polling -----------------------------------------------------------

async function pollAddress(address, flags) {
  const txns = await fetchRecentTxns(address);
  if (txns.length === 0) return;

  const newestId = txns[0].id;
  const prev = lastSeen.get(address);

  if (prev === undefined) {
    // First poll: baseline only, no notifications.
    lastSeen.set(address, newestId);
    log(`Primed ${address} at tx #${newestId}.`);
    return;
  }

  // New transactions are those with id > prev. Replay oldest-first so
  // multi-event ticks notify in chronological order.
  const fresh = txns.filter(t => t.id > prev).sort((a, b) => a.id - b.id);
  for (const tx of fresh) handleTxn(address, flags, tx);

  if (fresh.length > 0) {
    lastSeen.set(address, newestId);
  }
}

async function tick() {
  polling = true;
  drawStatus();
  log('Polling Kromer API…');

  let errors = 0;
  let events = changesDetected;
  for (const [addr, flags] of watched) {
    try {
      await pollAddress(addr, flags);
    } catch (err) {
      errors++;
      log(`[error ${addr}] ${err.message || err}`);
    }
  }
  pollsDone++;
  polling = false;
  nextPollAt = Date.now() + config.pollIntervalMs;

  const delta = changesDetected - events;
  if (delta === 0 && errors === 0) log('Poll complete — no changes.');
  else if (delta === 0) log(`Poll complete — ${errors} error(s).`);
  drawStatus();
}

// ---- Startup -----------------------------------------------------------

(async () => {
  setupRegion();
  log('Kromer notifier starting.');
  log(`Endpoint: ${API_BASE}`);
  log(
    `Watching: ${watched.size ? [...watched.keys()].join(', ') : '(none — add entries to config.json)'}`
  );
  log(`Interval: ${config.pollIntervalMs}ms`);

  if (watched.size === 0) {
    log('No addresses configured. Exiting.');
    teardownRegion();
    process.exit(0);
  }

  nextPollAt = Date.now() + config.pollIntervalMs;
  await tick();

  setInterval(tick, config.pollIntervalMs);
  setInterval(drawStatus, 1000);

  process.stdout.on('resize', () => {
    setupRegion();
    drawStatus();
  });

  const shutdown = () => {
    teardownRegion();
    console.log('Stopped.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})();
