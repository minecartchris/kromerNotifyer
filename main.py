"""
Kromer transaction notifier — Python port.

Primary mode: WebSocket subscription to the network `transactions` feed.
Fallback mode: HTTP polling of per-address transaction history when the
socket drops. A `lastSeenTxId` per address bridges gaps during fallback
and catches up when the socket reconnects.
"""

import ctypes
import json
import os
import signal
import sys
import threading
import time
from datetime import datetime

import requests
import websocket  # websocket-client package

try:
    from winotify import Notification, audio  # type: ignore
    HAS_WINOTIFY = True
except ImportError:
    HAS_WINOTIFY = False

# ---- Paths & config ----------------------------------------------------

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
ICON_PATH = os.path.join(BASE_DIR, "shitty-logo.png")
ICON = ICON_PATH if os.path.exists(ICON_PATH) else None

with open(CONFIG_PATH, "r", encoding="utf-8") as f:
    config = json.load(f)

SYNC_NODE = (config.get("apiBase") or "https://kromer.reconnected.cc/api/krist/").rstrip("/") + "/"
POLL_INTERVAL_MS = int(config.get("pollIntervalMs", 120_000))
POLL_INTERVAL_S = POLL_INTERVAL_MS / 1000.0

# address (lowercased) -> per-address notify flags
watched = {
    addr.lower(): {
        "income": bool(flags.get("income")),
        "paymentsOut": bool(flags.get("paymentsOut")),
        "namePurchases": bool(flags.get("namePurchases")),
        "nameTransfers": bool(flags.get("nameTransfers")),
    }
    for addr, flags in (config.get("watchAddresses") or {}).items()
}

# address -> last seen transaction id
last_seen: dict[str, int] = {}
state_lock = threading.Lock()

# ---- Pinned-bottom TUI -------------------------------------------------

IS_TTY = sys.stdout.isatty()


def enable_vt_mode():
    """On Windows 10+, enable ANSI escape sequence processing."""
    if os.name != "nt":
        return
    try:
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        mode = ctypes.c_ulong()
        if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            kernel32.SetConsoleMode(handle, mode.value | 0x0004)  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
    except Exception:
        pass


def term_size() -> tuple[int, int]:
    try:
        size = os.get_terminal_size()
        return size.columns, size.lines
    except OSError:
        return 120, 24


term_cols, term_rows = term_size()


def ansi(s: str):
    if IS_TTY:
        sys.stdout.write(s)
        sys.stdout.flush()


def setup_region():
    global term_cols, term_rows
    if not IS_TTY:
        return
    term_cols, term_rows = term_size()
    ansi(f"\x1b[1;{term_rows - 1}r")
    ansi(f"\x1b[{term_rows - 1};1H")


def teardown_region():
    if not IS_TTY:
        return
    ansi("\x1b[r")
    ansi(f"\x1b[{term_rows};1H")
    ansi("\x1b[2K")


mode = "starting"  # 'ws' | 'polling' | 'reconnecting' | 'starting'
events_total = 0
tx_seen = 0
next_poll_at = 0.0


def draw_status():
    if not IS_TTY:
        return
    with state_lock:
        if mode == "ws":
            state = "WS CONNECTED — live"
        elif mode == "polling":
            remaining = max(0, int(round(next_poll_at - time.time())))
            state = f"FALLBACK POLLING — next in {remaining}s"
        elif mode == "reconnecting":
            state = "WS RECONNECTING…"
        else:
            state = "starting…"
        left = (
            f"[watching {len(watched)} | tx seen: {tx_seen} "
            f"| notifications: {events_total}] {state}"
        )
    controls_plain = " Ctrl+X  save & quit"
    left_max = max(0, term_cols - len(controls_plain) - 2)
    if len(left) > left_max:
        left = left[:left_max]
    ansi("\x1b7")
    ansi(f"\x1b[{term_rows};1H")
    ansi("\x1b[2K")
    sys.stdout.write(left + "   ")
    sys.stdout.write("\x1b[7m Ctrl+X \x1b[0m save & quit")
    sys.stdout.flush()
    ansi("\x1b8")


def log(msg: str):
    stamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{stamp}] {msg}", flush=True)
    draw_status()


def notify(title: str, message: str):
    global events_total
    with state_lock:
        events_total += 1
    log(f"CHANGE — {title}: {message}")
    if HAS_WINOTIFY:
        try:
            toast = Notification(
                app_id="Kromer Notifier",
                title=f"Kromer: {title}",
                msg=message,
                icon=ICON or "",
            )
            toast.set_audio(audio.Default, loop=False)
            toast.show()
        except Exception as e:
            log(f"[notify error] {e}")


# ---- HTTP --------------------------------------------------------------

session = requests.Session()
session.headers.update({"Accept": "application/json"})


def get_json(path: str, params=None):
    url = SYNC_NODE + path.lstrip("/")
    r = session.get(url, params=params, timeout=10)
    r.raise_for_status()
    return r.json()


def post_json(path: str, body):
    url = SYNC_NODE + path.lstrip("/")
    r = session.post(url, json=body, timeout=10)
    r.raise_for_status()
    return r.json()


def fetch_address_txns(address: str, limit: int = 50):
    data = get_json(
        f"addresses/{address}/transactions",
        params={"limit": limit, "excludeMined": "true"},
    )
    return data.get("transactions") or []


# ---- Transaction classifier -------------------------------------------

def handle_txn(tx: dict):
    global tx_seen
    with state_lock:
        tx_seen += 1

    src = (tx.get("from") or "").lower()
    dst = (tx.get("to") or "").lower()

    touched: list[str] = []
    if src in watched:
        touched.append(src)
    if dst in watched and src != dst:
        touched.append(dst)
    if not touched:
        return

    tx_id = tx.get("id", 0)
    tx_type = tx.get("type")
    value = tx.get("value")
    name = tx.get("name")
    sent_metaname = tx.get("sent_metaname")
    sent_name = tx.get("sent_name")

    for address in touched:
        flags = watched[address]

        with state_lock:
            prev = last_seen.get(address, 0)
            if tx_id > prev:
                last_seen[address] = tx_id

        if tx_type == "transfer":
            if dst == address and flags["income"]:
                meta = f" (to {sent_metaname}@{sent_name})" if sent_metaname else ""
                notify(
                    "Income received",
                    f"{address} {value} KRO from {tx.get('from')}{meta}",
                )
            elif src == address and flags["paymentsOut"]:
                dest = f"{sent_metaname}@{sent_name}" if sent_metaname else tx.get("to")
                notify("Payment sent", f"{address} {value} KRO to {dest}")
        elif tx_type == "name_purchase":
            if src == address and flags["namePurchases"]:
                notify("Name purchased", f"{address} bought {name}.kro")
        elif tx_type == "name_transfer":
            if src == address and flags["nameTransfers"]:
                notify(
                    "Name transferred away",
                    f"{address} sent {name}.kro to {tx.get('to')}",
                )
            elif dst == address and flags["namePurchases"]:
                notify(
                    "Name received",
                    f"{address} received {name}.kro from {tx.get('from')}",
                )


# ---- Baseline & fallback polling --------------------------------------

def prime_address(address: str):
    try:
        txns = fetch_address_txns(address, limit=1)
        newest = txns[0]["id"] if txns else 0
        with state_lock:
            last_seen[address] = newest
        log(f"Primed {address} at tx #{newest}.")
    except Exception as e:
        log(f"[prime error {address}] {e}")
        with state_lock:
            last_seen[address] = 0


def poll_address(address: str):
    with state_lock:
        prev = last_seen.get(address, 0)
    txns = fetch_address_txns(address, limit=50)
    fresh = sorted((t for t in txns if t.get("id", 0) > prev), key=lambda t: t["id"])
    for tx in fresh:
        handle_txn(tx)


polling_stop = threading.Event()
polling_thread: threading.Thread | None = None


def polling_loop():
    global next_poll_at
    while not polling_stop.is_set():
        with state_lock:
            next_poll_at = time.time() + POLL_INTERVAL_S
        draw_status()
        for address in list(watched.keys()):
            if polling_stop.is_set():
                return
            try:
                poll_address(address)
            except Exception as e:
                log(f"[poll error {address}] {e}")
        # Wait out the interval (responsive to stop event)
        polling_stop.wait(POLL_INTERVAL_S)


def start_polling():
    global polling_thread, mode
    if polling_thread and polling_thread.is_alive():
        return
    with state_lock:
        mode = "polling"
    log("Falling back to HTTP polling.")
    polling_stop.clear()
    polling_thread = threading.Thread(target=polling_loop, daemon=True)
    polling_thread.start()


def stop_polling():
    global polling_thread
    if polling_thread and polling_thread.is_alive():
        polling_stop.set()
        polling_thread.join(timeout=2)
    polling_thread = None
    polling_stop.clear()


# ---- WebSocket --------------------------------------------------------

ws_should_run = True
ws_reconnect_delay = 1.0
ws_app: websocket.WebSocketApp | None = None
ws_thread: threading.Thread | None = None
ws_req_id = 1
ws_req_lock = threading.Lock()


def ws_next_id() -> int:
    global ws_req_id
    with ws_req_lock:
        n = ws_req_id
        ws_req_id += 1
        return n


def ws_start_url() -> str:
    resp = post_json("ws/start", {})
    return resp["url"]


def on_open(wsapp):
    # We subscribe after the server sends `hello`.
    pass


def on_message(wsapp, raw):
    try:
        data = json.loads(raw)
    except Exception:
        return

    dtype = data.get("type")
    if dtype == "hello":
        # Subscribe to the network transaction feed.
        payload = {"id": ws_next_id(), "type": "subscribe", "event": "transactions"}
        try:
            wsapp.send(json.dumps(payload))
        except Exception as e:
            log(f"[ws send error] {e}")
        global mode, ws_reconnect_delay
        with state_lock:
            mode = "ws"
            ws_reconnect_delay = 1.0
        stop_polling()
        log("WebSocket connected. Catching up on any missed transactions…")
        # Catch-up poll on a background thread (don't block the WS loop).
        def catchup():
            for address in list(watched.keys()):
                try:
                    poll_address(address)
                except Exception as e:
                    log(f"[catchup error {address}] {e}")
            log("Catch-up complete. Live.")
        threading.Thread(target=catchup, daemon=True).start()
    elif dtype == "keepalive":
        pass
    elif dtype == "event" and data.get("event") == "transaction":
        tx = data.get("transaction")
        if tx:
            handle_txn(tx)


def on_error(wsapp, err):
    # `on_close` will fire right after. Avoid double-logging.
    pass


def on_close(wsapp, code, reason):
    if not ws_should_run:
        return
    log(f"WebSocket closed ({code}).")
    schedule_reconnect()


def schedule_reconnect():
    global ws_reconnect_delay, mode
    if not ws_should_run:
        return
    start_polling()  # keep receiving events during the gap
    with state_lock:
        mode = "polling"
    delay = ws_reconnect_delay
    ws_reconnect_delay = min(ws_reconnect_delay * 2, 30.0)
    log(f"Reconnecting WebSocket in {int(delay)}s…")
    t = threading.Timer(delay, start_ws)
    t.daemon = True
    t.start()


def start_ws():
    global ws_app, ws_thread, mode
    if not ws_should_run:
        return
    with state_lock:
        mode = "reconnecting"
    draw_status()

    def runner():
        global ws_app
        try:
            url = ws_start_url()
        except Exception as e:
            log(f"[ws start error] {e}")
            schedule_reconnect()
            return

        ws_app = websocket.WebSocketApp(
            url,
            on_open=on_open,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close,
        )
        try:
            ws_app.run_forever(ping_interval=30, ping_timeout=10)
        except Exception as e:
            log(f"[ws run error] {e}")
            schedule_reconnect()

    ws_thread = threading.Thread(target=runner, daemon=True)
    ws_thread.start()


# ---- Status redraw timer ----------------------------------------------

def status_ticker():
    while True:
        time.sleep(1)
        draw_status()


# ---- Startup ----------------------------------------------------------

def fetch_address(address: str) -> dict:
    data = get_json(f"addresses/{address}")
    return data.get("address") or {}


def save_end_balances():
    log("Ctrl+X received — saving end.balance.json…")
    out = {
        "endedAt": datetime.utcnow().isoformat() + "Z",
        "endpoint": SYNC_NODE,
        "addresses": {},
    }
    for address in list(watched.keys()):
        entry = {"lastSeenTxId": last_seen.get(address, 0)}
        try:
            info = fetch_address(address)
            entry["balance"] = info.get("balance")
            entry["totalin"] = info.get("totalin")
            entry["totalout"] = info.get("totalout")
        except Exception as e:
            entry["error"] = str(e)
        out["addresses"][address] = entry
    try:
        with open(os.path.join(BASE_DIR, "end.balance.json"), "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2)
        log("Wrote end.balance.json.")
    except Exception as e:
        log(f"[save error] {e}")


def shutdown(*_, reason: str = "signal", save: bool = False):
    global ws_should_run
    if save:
        try:
            save_end_balances()
        except Exception as e:
            log(f"[save error] {e}")
    ws_should_run = False
    stop_polling()
    try:
        if ws_app is not None:
            ws_app.close()
    except Exception:
        pass
    teardown_region()
    print(f"Stopped ({reason}).")
    os._exit(0)


def key_listener():
    """Watch stdin for Ctrl+X (0x18) and trigger save-and-quit."""
    if os.name == "nt":
        try:
            import msvcrt
        except ImportError:
            return
        while True:
            ch = msvcrt.getch()
            if ch == b"\x18":  # Ctrl+X
                shutdown(reason="Ctrl+X", save=True)
                return
            if ch == b"\x03":  # Ctrl+C
                shutdown(reason="Ctrl+C")
                return
    else:
        try:
            import termios, tty
        except ImportError:
            return
        fd = sys.stdin.fileno()
        try:
            old = termios.tcgetattr(fd)
        except termios.error:
            return
        try:
            tty.setcbreak(fd)
            while True:
                ch = os.read(fd, 1)
                if ch == b"\x18":
                    shutdown(reason="Ctrl+X", save=True)
                    return
                if ch == b"\x03":
                    shutdown(reason="Ctrl+C")
                    return
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)


def main():
    enable_vt_mode()
    setup_region()

    log("Kromer notifier starting.")
    log(f"Endpoint: {SYNC_NODE}")
    addr_list = ", ".join(watched.keys()) if watched else "(none — add entries to config.json)"
    log(f"Watching: {addr_list}")
    log(f"Fallback poll interval: {POLL_INTERVAL_MS}ms")
    if not HAS_WINOTIFY:
        log("(winotify not installed — desktop notifications disabled, console logs only)")

    if not watched:
        teardown_region()
        print("No addresses configured. Exiting.")
        return

    for address in list(watched.keys()):
        prime_address(address)

    signal.signal(signal.SIGINT, lambda *_: shutdown(reason="SIGINT"))
    try:
        signal.signal(signal.SIGTERM, lambda *_: shutdown(reason="SIGTERM"))
    except Exception:
        pass

    start_ws()
    threading.Thread(target=status_ticker, daemon=True).start()
    threading.Thread(target=key_listener, daemon=True).start()

    # Main thread sleeps forever.
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
