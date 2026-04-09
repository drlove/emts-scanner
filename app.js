'use strict';

// ─── Audio ───────────────────────────────────────────────────────────────────
let audioCtx = null;

function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx.state === 'suspended' ? audioCtx.resume() : Promise.resolve();
}

function playBeep() {
  ensureAudioCtx().then(() => {
    try {
      const ctx = audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1046, ctx.currentTime);        // C6
      osc.frequency.setValueAtTime(1318, ctx.currentTime + 0.08); // E6
      gain.gain.setValueAtTime(0.35, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.25);
    } catch (_) {}
  }).catch(() => {});
}

// ─── State ───────────────────────────────────────────────────────────────────
let sqlDB = null;
let scanner = null;
let isScanning = false;
let lastScanText = null;
let lastScanAt = 0;
const DEBOUNCE_MS = 3000;

// ─── IndexedDB persistence for sql.js ────────────────────────────────────────
const IDB = {
  NAME: 'emts-scanner',
  STORE: 'sqlite',
  KEY: 'db',

  _open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(this.NAME, 1);
      r.onupgradeneeded = e => e.target.result.createObjectStore(this.STORE);
      r.onsuccess = e => res(e.target.result);
      r.onerror = e => rej(e.target.error);
    });
  },

  async load() {
    const db = await this._open();
    return new Promise((res, rej) => {
      const req = db.transaction(this.STORE, 'readonly').objectStore(this.STORE).get(this.KEY);
      req.onsuccess = e => res(e.target.result ?? null);
      req.onerror = e => rej(e.target.error);
    });
  },

  async save(buffer) {
    const db = await this._open();
    return new Promise((res, rej) => {
      const tx = db.transaction(this.STORE, 'readwrite');
      tx.objectStore(this.STORE).put(buffer, this.KEY);
      tx.oncomplete = res;
      tx.onerror = e => rej(e.target.error);
    });
  }
};

// ─── SQLite helpers ───────────────────────────────────────────────────────────
async function initSQLite() {
  const SQL = await initSqlJs({
    locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`
  });

  const saved = await IDB.load();
  if (saved) {
    sqlDB = new SQL.Database(new Uint8Array(saved));
  } else {
    sqlDB = new SQL.Database();
    sqlDB.run(`
      CREATE TABLE IF NOT EXISTS scans (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        data      TEXT    NOT NULL,
        format    TEXT    NOT NULL,
        scanned_at TEXT   NOT NULL
      )
    `);
    await flushDB();
  }
}

async function flushDB() {
  const buf = sqlDB.export();
  await IDB.save(buf.buffer);
}

function dbInsert(data, format) {
  const ts = new Date().toISOString();
  sqlDB.run('INSERT INTO scans (data, format, scanned_at) VALUES (?, ?, ?)', [data, format, ts]);
  flushDB();
}

function dbSelectAll() {
  const res = sqlDB.exec('SELECT id, data, format, scanned_at FROM scans ORDER BY id DESC');
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

function dbDelete(id) {
  sqlDB.run('DELETE FROM scans WHERE id = ?', [id]);
  flushDB();
}

function dbClear() {
  sqlDB.run('DELETE FROM scans');
  flushDB();
}

function dbCount() {
  const res = sqlDB.exec('SELECT COUNT(*) FROM scans');
  return res[0]?.values[0][0] ?? 0;
}

// ─── Scanner ─────────────────────────────────────────────────────────────────
function initScanner() {
  scanner = new Html5Qrcode('reader');
}

async function startScanner() {
  const btn = document.getElementById('scanBtn');
  btn.disabled = true;
  try {
    await scanner.start(
      { facingMode: 'environment' },
      {
        fps: 10,
        qrbox: (w, h) => {
          const side = Math.min(w, h, 280);
          return { width: side, height: side };
        },
        aspectRatio: 1.0
      },
      onScanSuccess,
      () => {} // suppress per-frame failures
    );
    isScanning = true;
    btn.textContent = 'Stop Scanner';
    btn.classList.replace('btn-primary', 'btn-danger');
  } catch (err) {
    showToast('Camera unavailable — try "Scan Image"', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function stopScanner() {
  if (!isScanning) return;
  const btn = document.getElementById('scanBtn');
  btn.disabled = true;
  try {
    await scanner.stop();
    scanner.clear();
  } catch (_) {}
  isScanning = false;
  clearInterval(cooldownTimer);
  cooldownTimer = null;
  delete btn.dataset.cooldown;
  document.getElementById('reader').classList.remove('locked');
  btn.textContent = 'Start Scanner';
  btn.classList.replace('btn-danger', 'btn-primary');
  btn.disabled = false;
  hideLastScan();
}

let cooldownTimer = null;

function onScanSuccess(text, result) {
  const now = Date.now();
  if (text === lastScanText && now - lastScanAt < DEBOUNCE_MS) return;
  lastScanText = text;
  lastScanAt = now;

  const format = result?.result?.format?.formatName ?? 'Unknown';
  playBeep();
  dbInsert(text, format);
  renderTable();
  showLastScan(text);
  startCooldown();
}

function startCooldown() {
  const viewfinder = document.getElementById('reader');
  const btn = document.getElementById('scanBtn');

  viewfinder.classList.add('locked');

  let remaining = Math.ceil(DEBOUNCE_MS / 1000);
  btn.dataset.label = btn.textContent.trim();
  btn.dataset.cooldown = '1';
  btn.textContent = `⏳ ${remaining}s`;

  clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
      btn.textContent = btn.dataset.label;
      delete btn.dataset.cooldown;
      viewfinder.classList.remove('locked');
    } else {
      btn.textContent = `⏳ ${remaining}s`;
    }
  }, 1000);
}

async function scanImageFile(file) {
  try {
    let text, format;
    if (typeof Html5Qrcode.scanFileV2 === 'function') {
      const r = await Html5Qrcode.scanFileV2(file, false);
      text = r.decodedText;
      format = r.result?.format?.formatName ?? 'Image';
    } else {
      text = await Html5Qrcode.scanFile(file, false);
      format = 'Image';
    }
    playBeep();
    dbInsert(text, format);
    renderTable();
    showToast('Scanned from image');
  } catch {
    showToast('No barcode detected in image', 'error');
  }
}

// ─── UI helpers ──────────────────────────────────────────────────────────────
function showLastScan(text) {
  const bar = document.getElementById('lastScanBar');
  document.getElementById('lastScanText').textContent = text;
  bar.classList.add('visible');
  clearTimeout(bar._timer);
  bar._timer = setTimeout(hideLastScan, 3000);
}

function hideLastScan() {
  document.getElementById('lastScanBar').classList.remove('visible');
}

function renderTable() {
  const rows = dbSelectAll();
  const tbody = document.getElementById('scansBody');
  const count = document.getElementById('scanCount');

  const n = rows.length;
  count.textContent = `${n} scan${n !== 1 ? 's' : ''}`;

  if (!n) {
    tbody.innerHTML = `
      <tr><td colspan="4" class="empty-state">
        <div class="empty-state-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/>
            <rect x="7" y="7" width="3" height="10" rx="1"/>
            <rect x="11" y="7" width="1.5" height="10" rx="0.5"/>
            <rect x="14" y="7" width="3" height="10" rx="1"/>
          </svg>
        </div>
        No scans yet — start the scanner or upload an image
      </td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td class="td-data" title="${esc(r.data)}">${esc(r.data)}</td>
      <td><span class="format-badge">${esc(r.format)}</span></td>
      <td class="td-time">${fmtTime(r.scanned_at)}</td>
      <td class="td-actions">
        <button class="btn-icon" title="Copy" onclick="copyText(${JSON.stringify(r.data)})">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2"/>
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
          </svg>
        </button>
        <button class="btn-icon danger" title="Delete" onclick="deleteRow(${r.id})">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4h6v2"/>
          </svg>
        </button>
      </td>
    </tr>`).join('');
}

function deleteRow(id) {
  dbDelete(id);
  renderTable();
}

function copyText(text) {
  navigator.clipboard.writeText(text)
    .then(() => showToast('Copied to clipboard'))
    .catch(() => showToast('Copy failed', 'error'));
}

function exportCSV() {
  const rows = dbSelectAll();
  if (!rows.length) { showToast('Nothing to export', 'error'); return; }
  const lines = [
    'ID,Data,Format,Timestamp',
    ...rows.map(r => `${r.id},"${String(r.data).replace(/"/g, '""')}","${r.format}","${r.scanned_at}"`)
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `scans-${new Date().toISOString().slice(0, 10)}.csv`
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─── Misc utils ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function setStatus(text, cls = '') {
  const el = document.getElementById('statusBadge');
  el.textContent = text;
  el.className = 'status-badge' + (cls ? ' ' + cls : '');
}

const toastContainer = (() => {
  const el = document.createElement('div');
  el.className = 'toast-container';
  document.body.appendChild(el);
  return el;
})();

function showToast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  toastContainer.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 2600);
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
async function init() {
  // Register SW
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  setStatus('Loading…');

  try {
    await initSQLite();
  } catch (err) {
    setStatus('DB Error', 'error');
    console.error('SQLite init failed:', err);
    return;
  }

  initScanner();
  renderTable();
  setStatus('Ready', 'ready');

  // Scan button
  document.getElementById('scanBtn').addEventListener('click', () => {
    ensureAudioCtx(); // warm up audio on first user gesture
    isScanning ? stopScanner() : startScanner();
  });

  // File input
  document.getElementById('fileInput').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) await scanImageFile(f);
    e.target.value = '';
  });

  // Clear button
  document.getElementById('clearBtn').addEventListener('click', () => {
    if (dbCount() === 0) return;
    if (confirm('Delete all scan records?')) {
      dbClear();
      renderTable();
    }
  });

  // Export button
  document.getElementById('exportBtn').addEventListener('click', exportCSV);

  // Release camera on page hide
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && isScanning) stopScanner();
  });
}

document.addEventListener('DOMContentLoaded', init);
