/* ---------------------------------------------------------------------
 * Arduino Web IDE - frontend logic
 * - CodeMirror editor
 * - POST /compile -> arduino-cli on the server -> returns an Intel HEX string
 * - In-browser STK500v1 (Optiboot) programmer over the Web Serial API
 * - Simple serial monitor
 * ------------------------------------------------------------------- */

const DEFAULT_SKETCH = `void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
  Serial.println("Hello from your Arduino Uno!");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
`;

const editor = CodeMirror.fromTextArea(document.getElementById('code'), {
  mode: 'text/x-c++src',
  theme: 'dracula',
  lineNumbers: true,
  indentUnit: 2,
  tabSize: 2,
  autofocus: true,
});
editor.setValue(localStorage.getItem('awi-sketch') || DEFAULT_SKETCH);
editor.on('change', () => localStorage.setItem('awi-sketch', editor.getValue()));

const logEl = document.getElementById('log');
const progressFill = document.getElementById('progressFill');
const portBadge = document.getElementById('portBadge');
const connectBtn = document.getElementById('connectBtn');
const compileBtn = document.getElementById('compileBtn');
const uploadBtn = document.getElementById('uploadBtn');
const clearLogBtn = document.getElementById('clearLogBtn');

function log(msg, cls = 'log-info') {
  const line = document.createElement('div');
  line.className = `log-line ${cls}`;
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}
clearLogBtn.onclick = () => (logEl.innerHTML = '');

function setProgress(pct) {
  progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

if (!('serial' in navigator)) {
  log('Your browser does not support the Web Serial API. Please use Chrome or Edge on desktop.', 'log-err');
  connectBtn.disabled = true;
  uploadBtn.disabled = true;
}

/* ----------------------------- Compile -------------------------------- */

async function compileSketch() {
  log('Compiling…', 'log-dim');
  const res = await fetch('/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: editor.getValue() }),
  });
  const data = await res.json();
  if (!data.ok) {
    log('Compile failed:', 'log-err');
    log(data.error || 'Unknown compiler error', 'log-err');
    throw new Error('compile failed');
  }
  log('Compiled successfully.', 'log-ok');
  return data.hex;
}

compileBtn.onclick = async () => {
  compileBtn.disabled = true;
  try {
    await compileSketch();
  } catch (e) {
    /* already logged */
  } finally {
    compileBtn.disabled = false;
  }
};

/* --------------------------- Intel HEX parse ---------------------------- */

function parseIntelHex(hexText) {
  const bytesByAddress = new Map();
  let extendedAddr = 0;
  let maxAddr = 0;

  for (const rawLine of hexText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line[0] !== ':') continue;
    const byteCount = parseInt(line.substr(1, 2), 16);
    const address = parseInt(line.substr(3, 4), 16);
    const recordType = parseInt(line.substr(7, 2), 16);
    const dataStart = 9;

    if (recordType === 0x00) {
      for (let i = 0; i < byteCount; i++) {
        const byte = parseInt(line.substr(dataStart + i * 2, 2), 16);
        const fullAddr = extendedAddr + address + i;
        bytesByAddress.set(fullAddr, byte);
        if (fullAddr > maxAddr) maxAddr = fullAddr;
      }
    } else if (recordType === 0x04) {
      const upper = parseInt(line.substr(dataStart, 4), 16);
      extendedAddr = upper << 16;
    } else if (recordType === 0x02) {
      const seg = parseInt(line.substr(dataStart, 4), 16);
      extendedAddr = seg << 4;
    }
    // 0x01 = EOF, ignored; 0x03/0x05 start-address records ignored (not relevant for AVR flash images)
  }

  const length = maxAddr + 1;
  const flash = new Uint8Array(length);
  flash.fill(0xff);
  for (const [addr, byte] of bytesByAddress.entries()) flash[addr] = byte;
  return flash;
}

/* --------------------------- Web Serial link ---------------------------- */

let sharedPort = null; // reused by both the uploader and the monitor

class SerialLink {
  constructor(port) {
    this.port = port;
    this.rx = [];
    this.reading = false;
    this.reader = null;
    this.onByte = null; // optional live callback, used by the monitor
  }

  start() {
    this.reading = true;
    this.reader = this.port.readable.getReader();
    (async () => {
      try {
        while (this.reading) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) {
            for (const b of value) {
              this.rx.push(b);
              if (this.onByte) this.onByte(b);
            }
          }
        }
      } catch (e) {
        // expected when the port is closed/cancelled
      }
    })();
  }

  async stop() {
    this.reading = false;
    try {
      await this.reader.cancel();
    } catch (e) {}
    try {
      this.reader.releaseLock();
    } catch (e) {}
  }

  async write(bytes) {
    const writer = this.port.writable.getWriter();
    await writer.write(new Uint8Array(bytes));
    writer.releaseLock();
  }

  clear() {
    this.rx.length = 0;
  }

  async readBytes(n, timeoutMs) {
    const start = performance.now();
    while (this.rx.length < n) {
      if (performance.now() - start > timeoutMs) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 4));
    }
    return this.rx.splice(0, n);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* --------------------------- STK500v1 protocol --------------------------- */
/* Matches what avrdude's "arduino" programmer does against an Optiboot
 * bootloader - the standard bootloader on genuine and most clone Uno boards. */

const CRC_EOP = 0x20;
const STK_GET_SYNC = 0x30;
const STK_ENTER_PROGMODE = 0x50;
const STK_LEAVE_PROGMODE = 0x51;
const STK_LOAD_ADDRESS = 0x55;
const STK_PROG_PAGE = 0x64;
const RESP_INSYNC = 0x14;
const RESP_OK = 0x10;
const PAGE_SIZE = 128; // ATmega328P flash page size in bytes

async function expectInsyncOk(link, timeoutMs) {
  const r = await link.readBytes(2, timeoutMs);
  if (r[0] !== RESP_INSYNC || r[1] !== RESP_OK) {
    throw new Error(`Unexpected bootloader response: ${r.map((b) => b.toString(16)).join(' ')}`);
  }
}

/**
 * Sends a command and waits for INSYNC/OK, retrying the whole exchange a few
 * times if the board doesn't answer in time. A single missed read (common
 * over USB-serial chips / driver buffering) shouldn't fail the whole upload.
 */
async function stkCommand(link, bytes, timeoutMs, label, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    link.clear();
    await link.write(bytes);
    try {
      await expectInsyncOk(link, timeoutMs);
      return;
    } catch (e) {
      lastErr = e;
      log(`${label}: no response (attempt ${i + 1}/${attempts}), retrying…`, 'log-dim');
      await sleep(60);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastErr.message}`);
}

async function resetIntoBootloader(port) {
  // Pulse DTR to trigger the auto-reset circuit that Optiboot boards use.
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  await sleep(250);
  await port.setSignals({ dataTerminalReady: true, requestToSend: true });
  await sleep(120);
}

async function stk500Sync(link) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    link.clear();
    await link.write([STK_GET_SYNC, CRC_EOP]);
    try {
      const r = await link.readBytes(2, 180);
      if (r[0] === RESP_INSYNC && r[1] === RESP_OK) return;
    } catch (e) {
      /* no response yet, retry */
    }
  }
  throw new Error(
    'Could not sync with the bootloader. Make sure the correct board is selected and connected, ' +
      'then try again (for boards without auto-reset, press the reset button right as Upload starts).'
  );
}

async function flashHex(port, hexText, onProgress) {
  const flash = parseIntelHex(hexText);
  const totalPages = Math.ceil(flash.length / PAGE_SIZE);

  const link = new SerialLink(port);
  link.start();

  try {
    log('Resetting board into bootloader…', 'log-dim');
    await resetIntoBootloader(port);

    log('Syncing with bootloader…', 'log-dim');
    await stk500Sync(link);
    log('Bootloader synced.', 'log-ok');

    log('Entering programming mode…', 'log-dim');
    await stkCommand(link, [STK_ENTER_PROGMODE, CRC_EOP], 1500, 'Enter programming mode');

    log(`Writing ${totalPages} page(s) of ${PAGE_SIZE} bytes…`, 'log-dim');
    for (let page = 0; page < totalPages; page++) {
      const start = page * PAGE_SIZE;
      const end = Math.min(start + PAGE_SIZE, flash.length);
      const chunk = flash.slice(start, end);
      const padded = new Uint8Array(PAGE_SIZE).fill(0xff);
      padded.set(chunk);

      const wordAddr = start / 2;
      await stkCommand(
        link,
        [STK_LOAD_ADDRESS, wordAddr & 0xff, (wordAddr >> 8) & 0xff, CRC_EOP],
        1000,
        `Page ${page + 1}/${totalPages}: load address`
      );

      await stkCommand(
        link,
        [STK_PROG_PAGE, (PAGE_SIZE >> 8) & 0xff, PAGE_SIZE & 0xff, 0x46, ...padded, CRC_EOP],
        2500,
        `Page ${page + 1}/${totalPages}: write page`
      );

      onProgress((page + 1) / totalPages);
    }

    log('Leaving programming mode…', 'log-dim');
    await stkCommand(link, [STK_LEAVE_PROGMODE, CRC_EOP], 1500, 'Leave programming mode');

    log(`Upload complete — ${flash.length} bytes written.`, 'log-ok');
  } finally {
    await link.stop();
  }
}

/* ------------------------------ Connect UI ------------------------------ */

async function ensurePort() {
  if (sharedPort) return sharedPort;
  sharedPort = await navigator.serial.requestPort();
  await sharedPort.open({ baudRate: 115200 });
  portBadge.textContent = 'board connected';
  portBadge.classList.add('connected');
  uploadBtn.disabled = false;
  return sharedPort;
}

connectBtn.onclick = async () => {
  try {
    await ensurePort();
    log('Board connected.', 'log-ok');
  } catch (e) {
    log(`Could not connect: ${e.message}`, 'log-err');
  }
};

uploadBtn.onclick = async () => {
  uploadBtn.disabled = true;
  compileBtn.disabled = true;
  setProgress(0);
  try {
    if (monitorOpen) await closeMonitor();
    const hex = await compileSketch();
    const port = await ensurePort();
    // If the port is currently open at a different baud (e.g. left over
    // from the monitor), reopen it at the fixed programming baud rate.
    if (port.readable === null) await port.open({ baudRate: 115200 });
    log('Uploading…', 'log-dim');
    await flashHex(port, hex, (frac) => setProgress(frac * 100));
    setProgress(100);
  } catch (e) {
    log(`Upload failed: ${e.message}`, 'log-err');
  } finally {
    uploadBtn.disabled = false;
    compileBtn.disabled = false;
    setTimeout(() => setProgress(0), 1500);
  }
};

/* ------------------------------ Serial monitor --------------------------- */

const monitorOut = document.getElementById('monitorOut');
const monitorToggleBtn = document.getElementById('monitorToggleBtn');
const monitorInput = document.getElementById('monitorInput');
const monitorSendBtn = document.getElementById('monitorSendBtn');
const baudSelect = document.getElementById('baudSelect');

let monitorLink = null;
let monitorOpen = false;

function appendMonitor(text) {
  monitorOut.textContent += text;
  monitorOut.scrollTop = monitorOut.scrollHeight;
}

async function openMonitor() {
  const baud = parseInt(baudSelect.value, 10);
  try {
    const port = await ensurePort();
    if (port.readable) {
      // Close and reopen at the requested monitor baud rate.
      await port.close();
    }
    await port.open({ baudRate: baud });
    monitorLink = new SerialLink(port);
    const decoder = new TextDecoder();
    monitorLink.onByte = (b) => appendMonitor(decoder.decode(new Uint8Array([b]), { stream: true }));
    monitorLink.start();
    monitorOpen = true;
    monitorToggleBtn.textContent = 'Close';
    appendMonitor(`\n--- connected at ${baud} baud ---\n`);
  } catch (e) {
    log(`Could not open serial monitor: ${e.message}`, 'log-err');
  }
}

async function closeMonitor() {
  if (monitorLink) {
    await monitorLink.stop();
    monitorLink = null;
  }
  monitorOpen = false;
  monitorToggleBtn.textContent = 'Open';
  appendMonitor('\n--- disconnected ---\n');
}

monitorToggleBtn.onclick = () => (monitorOpen ? closeMonitor() : openMonitor());

async function sendMonitorLine() {
  if (!monitorOpen || !monitorLink) return;
  const text = monitorInput.value;
  if (!text) return;
  const encoder = new TextEncoder();
  await monitorLink.write(encoder.encode(text + '\n'));
  monitorInput.value = '';
}
monitorSendBtn.onclick = sendMonitorLine;
monitorInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMonitorLine();
});
