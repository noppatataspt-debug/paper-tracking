/* ============================================================
   Paper Tracker — Scanner Page Logic
   Used by: index.html
   
   Scope: การสแกน barcode, validate, บันทึก batch
   ============================================================ */

import { supabase } from './config.js';

// DATA will be populated from Supabase on page load
let DATA = { machines: [], products: [] };

const state = {
  date: '',
  machineId: null,
  machineName: '',
  dp: '',
  products: [],  // array of product names
  currentProductIdx: 0,  // ตัวที่กำลังสแกนอยู่
  scans: [],  // { ..., productIdx }
  sharedMode: true  // default: ม้วน 1 ตัว = share ทุกสินค้า
};

// Sample barcodes for quick-test chips
const SAMPLE_BARCODES = [
  'CPS450_030125_6_1_77-4-A7914-4G',
  'CBCL-210_261224_3_4_05640606661W',
  'CBS350_030125_2_2_77-4-A7850-4G',
  'SB-110_241224_2_4_55-4-A5125-4K',
  'MF450_300125_3_2_77-5-A0315-4I',
  'CPS450_191224_2_1_77-4-A7268-4I'
];

function parseBarcode(bc) {
  const parts = bc.split('_');
  if (parts.length < 5) return null;
  return {
    paper_type: parts[0],
    cut_date: parts[1],
    roll_no: parts[2],
    slitter: parts[3],
    jumbo_lot: parts[4]
  };
}

// Normalize barcode — ปรับ format ให้ถูกต้องก่อน validate
// คืน { normalized: string, changes: [descriptions] }
function normalizeBarcode(bc) {
  if (!bc || !bc.trim()) return { normalized: '', changes: [] };
  const original = bc;
  let result = bc.trim();
  const changes = [];

  // Paper type typo mapping (จากการวิเคราะห์ข้อมูลจริงปี 2026)
  // key = uppercase + ไม่มี space, value = ชื่อที่ถูกต้องใน master list
  const PAPER_TYPE_FIX = {
    'M700/480':  'M700-490',
    'M400/450':  'M400-440',
    'SB110/150': 'SB-110',
    'PRONEW80':  'OFFSET-80',   // หลัง remove space จะเป็น PRONEW80
    'M800/380':  'M900-380',
    'CB450':     'CBE-450'
  };

  // 1. Uppercase ทั้งหมด (เช่น cps450 → CPS450, 77-5-a8295-3h → 77-5-A8295-3H)
  if (result !== result.toUpperCase()) {
    result = result.toUpperCase();
    changes.push('ตัวพิมพ์เล็ก → ใหญ่');
  }

  // 2. ลบ space ที่อยู่ใน barcode (เช่น "CPS 450_..." → "CPS450_...", "PRO NEW80" → "PRONEW80")
  if (result.includes(' ')) {
    result = result.replace(/\s+/g, '');
    changes.push('ลบช่องว่าง');
  }

  // 3. Split ตาม _ → แก้ paper type + cut_date
  const parts = result.split('_');
  if (parts.length === 5) {
    let [paper, date, roll, slitter, lot] = parts;

    // 3a. Paper type typo fix
    if (PAPER_TYPE_FIX[paper]) {
      const fixed = PAPER_TYPE_FIX[paper];
      changes.push('ประเภทกระดาษ: ' + paper + ' → ' + fixed);
      paper = fixed;
    }

    // 3b. Cut date: แก้ 19/12/25 → 191225, 6/1/26 → 060126
    if (/[\/\-]/.test(date)) {
      const digits = date.replace(/[\/\-]/g, '');
      // ถ้าได้ 5-6 หลัก (เช่น 19/12/25 → 191225)
      if (/^\d{5,6}$/.test(digits)) {
        let fixed = digits;
        if (digits.length === 5) {
          // วันเป็นเลขหลักเดียว → เติม 0 ข้างหน้า
          fixed = '0' + digits;
        }
        if (/^\d{6}$/.test(fixed)) {
          changes.push('วันที่ตัด: ' + date + ' → ' + fixed);
          date = fixed;
        }
      } else if (/^\d{4,8}$/.test(digits)) {
        // case 6/1/26 → ต้องเติม 0 ทั้งวันและเดือน
        const dateParts = date.split(/[\/\-]/);
        if (dateParts.length === 3) {
          const [d, m, y] = dateParts;
          if (/^\d{1,2}$/.test(d) && /^\d{1,2}$/.test(m) && /^\d{2,4}$/.test(y)) {
            const dd = d.padStart(2, '0');
            const mm = m.padStart(2, '0');
            const yy = y.length === 4 ? y.slice(2) : y.padStart(2, '0');
            const fixed = dd + mm + yy;
            changes.push('วันที่ตัด: ' + date + ' → ' + fixed);
            date = fixed;
          }
        }
      }
    }

    // Reconstruct
    result = [paper, date, roll, slitter, lot].join('_');
  }

  return {
    normalized: result,
    changes: changes,
    wasChanged: result !== original
  };
}

// Validate barcode format — returns { valid: bool, warnings: [] }
function validateBarcode(bc) {
  const warnings = [];

  if (!bc || !bc.trim()) {
    return { valid: false, warnings: ['Barcode ว่างเปล่า'], fatal: true };
  }

  // 1. Must have exactly 5 parts
  const parts = bc.split('_');
  if (parts.length < 5) {
    warnings.push(`โครงสร้างผิด: มี "_" เพียง ${parts.length - 1} ตัว (ต้องมี 4 ตัว)`);
    warnings.push('รูปแบบที่ถูก: ประเภท_วันตัด_ม้วน_slitter_ล็อต');
    return { valid: false, warnings, fatal: true };
  }
  if (parts.length > 5) {
    warnings.push(`โครงสร้างผิด: มี "_" มากเกินไป (${parts.length - 1} ตัว ต้องมี 4 ตัว)`);
    warnings.push('อาจสแกน 2 ม้วนติดกัน หรือล็อตมี "_" ในชื่อ');
    return { valid: false, warnings, fatal: true };
  }

  const [paperType, cutDate, rollNo, slitter, jumboLot] = parts;

  // 2. No part should be empty
  const emptyFields = [];
  if (!paperType) emptyFields.push('ประเภทกระดาษ');
  if (!cutDate) emptyFields.push('วันที่ตัด');
  if (!rollNo) emptyFields.push('ม้วนที่');
  if (!slitter) emptyFields.push('Slitter');
  if (!jumboLot) emptyFields.push('ล็อตจัมโบ้');

  if (emptyFields.length > 0) {
    warnings.push(`ข้อมูลว่าง: ${emptyFields.join(', ')}`);
    return { valid: false, warnings, fatal: true };
  }

  // 3. cut_date should be 5-6 digits
  if (!/^\d{5,6}$/.test(cutDate)) {
    if (/[\/\-]/.test(cutDate)) {
      warnings.push(`วันที่ตัด "${cutDate}" มี / หรือ - (ควรเป็นเลขล้วน 6 หลัก)`);
    } else if (cutDate.length < 5) {
      warnings.push(`วันที่ตัด "${cutDate}" สั้นเกินไป (ควร 5-6 หลัก)`);
    } else if (cutDate.length > 6) {
      warnings.push(`วันที่ตัด "${cutDate}" ยาวเกินไป (ควร 5-6 หลัก)`);
    } else {
      warnings.push(`วันที่ตัด "${cutDate}" ไม่ใช่ตัวเลข`);
    }
  }

  // 4. roll_no should be 1-2 digit number
  if (!/^\d{1,2}$/.test(rollNo)) {
    warnings.push(`ม้วนที่ "${rollNo}" ควรเป็นตัวเลข 1-2 หลัก`);
  }

  // 5. slitter should be 1-2 digit number
  if (!/^\d{1,2}$/.test(slitter)) {
    warnings.push(`Slitter "${slitter}" ควรเป็นตัวเลข 1-2 หลัก`);
  }

  // 6. Warn if barcode looks like 2 concatenated ones
  if (bc.length > 60) {
    warnings.push('Barcode ยาวผิดปกติ อาจสแกนติดกัน 2 ม้วน');
  }

  return {
    valid: warnings.length === 0,
    warnings,
    fatal: false
  };
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  let cls = 'toast show';
  if (type === true || type === 'error') cls += ' error';
  else if (type === 'warning') cls += ' warning';
  t.className = cls;
  setTimeout(() => t.classList.remove('show'), type === 'warning' ? 3000 : 1500);
}

// ===== Sound feedback using Web Audio API =====
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn('Audio not supported');
    }
  }
  return audioCtx;
}

function playBeep(type) {
  const ctx = getAudioContext();
  if (!ctx) return;

  // Resume context if suspended (browser autoplay policy)
  if (ctx.state === 'suspended') ctx.resume();

  const now = ctx.currentTime;

  if (type === 'success') {
    // Quick single beep (เสียงสั้น สูง)
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = 1000;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.3, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
    osc.start(now);
    osc.stop(now + 0.15);
  } else if (type === 'error') {
    // Low buzz x3 (เสียงต่ำ ดัง ซ้ำ 3 ครั้ง)
    for (let i = 0; i < 3; i++) {
      const start = now + i * 0.18;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'square';
      osc.frequency.value = 180;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.25, start + 0.01);
      gain.gain.linearRampToValueAtTime(0.25, start + 0.12);
      gain.gain.linearRampToValueAtTime(0, start + 0.15);
      osc.start(start);
      osc.stop(start + 0.15);
    }
  } else if (type === 'warning') {
    // Two quick beeps (เตือน 2 ครั้งกลาง ๆ)
    for (let i = 0; i < 2; i++) {
      const start = now + i * 0.15;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = 600;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.25, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.01, start + 0.1);
      osc.start(start);
      osc.stop(start + 0.12);
    }
  }
}

// ===== Error Modal =====
function showErrorModal(barcode, reasons) {
  document.getElementById('err-barcode').textContent = barcode || '(ว่าง)';
  const list = document.getElementById('err-reasons');
  list.innerHTML = reasons.map(r =>
    `<div class="error-reason">
      <span class="error-reason-icon">✕</span>
      <span>${escapeHtml(r)}</span>
    </div>`
  ).join('');
  document.getElementById('error-modal').classList.add('show');
  playBeep('error');
}
function hideErrorModal() {
  document.getElementById('error-modal').classList.remove('show');
  // Refocus scan input + process pending barcode if any
  setTimeout(() => {
    const si = document.getElementById('scan-input');
    if (si) {
      si.value = '';
      si.focus();
      // ถ้ามี barcode รออยู่ (จากกรณี 2 ตัวติดกัน) → ใส่กลับและ process
      if (window._pendingBarcode) {
        const pending = window._pendingBarcode;
        window._pendingBarcode = null;
        si.value = pending;
        si.dispatchEvent(new Event('input'));
      }
    }
  }, 50);
}
document.getElementById('err-btn-close').addEventListener('click', hideErrorModal);
document.getElementById('err-btn-retry').addEventListener('click', hideErrorModal);
// Close on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('error-modal').classList.contains('show')) {
    hideErrorModal();
  }
});

function goToScreen(n) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + n).classList.add('active');
  document.querySelectorAll('.step').forEach(s => {
    const sn = parseInt(s.dataset.step);
    s.classList.remove('active', 'done');
    if (sn < n && n <= 3) s.classList.add('done');
    if (sn === n && n <= 3) s.classList.add('active');
  });
  if (n === 2) setTimeout(() => document.getElementById('scan-input').focus(), 100);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ========== SCREEN 1: SETUP ==========

// --- Date ---
const fDate = document.getElementById('f-date');
fDate.valueAsDate = new Date();

// --- Machines with DP tabs ---
const dpTabs = document.getElementById('dp-tabs');
const machineGrid = document.getElementById('machine-grid');
let selectedDp = null;  // Set when data loads

function renderDpTabs() {
  const departments = [...new Set(DATA.machines.map(m => m.dp))];
  if (!selectedDp && departments.length > 0) {
    selectedDp = departments[0];
  }
  dpTabs.innerHTML = departments.map(dp => {
    const count = DATA.machines.filter(m => m.dp === dp).length;
    const isActive = dp === selectedDp;
    return `<button class="dp-tab ${isActive ? 'active' : ''}" data-dp="${escapeHtml(dp)}">
      ${escapeHtml(dp)} (${count})
    </button>`;
  }).join('');
  dpTabs.querySelectorAll('.dp-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedDp = btn.dataset.dp;
      renderDpTabs();
      renderMachineGrid();
    });
  });
}

function renderMachineGrid() {
  const machines = DATA.machines.filter(m => m.dp === selectedDp);
  machineGrid.innerHTML = machines.map(m => {
    const isSelected = state.machineId === m.id;
    return `<button class="machine-btn ${isSelected ? 'selected' : ''}" data-id="${m.id}">
      ${escapeHtml(m.name)}
    </button>`;
  }).join('');
  machineGrid.querySelectorAll('.machine-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.id);
      const m = DATA.machines.find(x => x.id === id);
      state.machineId = m.id;
      state.machineName = m.name;
      state.dp = m.dp;
      document.getElementById('machine-hint').textContent = '✓ เลือก: ' + m.name;
      renderMachineGrid();
      checkSetup();
    });
  });
}

// Initial renders happen after Supabase load (see loadMasterData below)

// --- Product multi-row autocomplete ---
const productRows = document.getElementById('product-rows');
const btnAddProduct = document.getElementById('btn-add-product');

// product entry data: [{ value: string, isValid: bool }]
let productEntries = [{ value: '', isValid: false }];
let activeAcRow = -1;  // which row's autocomplete is open
let acActiveIdx = -1;
let acItems = [];

function filterProducts(q) {
  q = q.trim().toUpperCase();
  if (!q) return DATA.products.slice(0, 50);
  const scored = DATA.products.map(p => {
    const pu = p.toUpperCase();
    let score = 0;
    if (pu === q) score = 1000;
    else if (pu.startsWith(q)) score = 500 - pu.length;
    else if (pu.includes(q)) score = 100 - pu.indexOf(q);
    return { p, score };
  }).filter(x => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 50).map(x => x.p);
}

function highlightMatch(text, q) {
  if (!q) return escapeHtml(text);
  q = q.trim();
  if (!q) return escapeHtml(text);
  const idx = text.toUpperCase().indexOf(q.toUpperCase());
  if (idx < 0) return escapeHtml(text);
  return escapeHtml(text.substring(0, idx)) +
         '<mark>' + escapeHtml(text.substring(idx, idx + q.length)) + '</mark>' +
         escapeHtml(text.substring(idx + q.length));
}

function renderProductRows() {
  productRows.innerHTML = productEntries.map((entry, idx) => {
    const canRemove = productEntries.length > 1;
    const stateClass = entry.isValid
      ? (entry.isNew ? 'valid-new' : 'valid')
      : '';
    const badgeHtml = entry.isValid
      ? `<span class="product-badge ${entry.isNew ? 'new' : 'master'}">${entry.isNew ? 'ใหม่' : '✓ MASTER'}</span>`
      : '';
    return `<div class="product-row">
      <div class="product-row-num">${idx + 1}</div>
      <div class="product-row-input">
        <input type="text" class="p-input ${stateClass}" data-idx="${idx}"
               value="${escapeHtml(entry.value)}"
               placeholder="พิมพ์เพื่อค้นหา เช่น VKPC, TK, SKIC..."
               autocomplete="off">
        ${badgeHtml}
        <div class="autocomplete-dropdown" data-idx="${idx}"></div>
      </div>
      <button type="button" class="product-row-remove" data-idx="${idx}"
              ${canRemove ? '' : 'disabled'} title="ลบสินค้านี้">✕</button>
    </div>`;
  }).join('');

  productRows.querySelectorAll('.p-input').forEach(input => {
    const idx = parseInt(input.dataset.idx);
    input.addEventListener('focus', () => {
      activeAcRow = idx;
      acActiveIdx = -1;
      // Only show dropdown if user has already typed something
      if (input.value.trim()) {
        renderAcDropdown(idx, true);
      }
    });
    input.addEventListener('blur', () => setTimeout(() => {
      renderAcDropdown(idx, false);
      commitRowValue(idx);
    }, 150));
    input.addEventListener('input', () => {
      productEntries[idx].value = input.value;
      const trimmed = input.value.trim();
      if (DATA.products.includes(trimmed)) {
        productEntries[idx].isValid = true;
        productEntries[idx].isNew = false;
      } else {
        productEntries[idx].isValid = false;
        productEntries[idx].isNew = false;
      }
      acActiveIdx = -1;
      // Show dropdown only when there's input
      renderAcDropdown(idx, trimmed.length > 0);
      checkSetup();
    });
    input.addEventListener('keydown', (e) => {
      const dd = productRows.querySelector(`.autocomplete-dropdown[data-idx="${idx}"]`);
      if (!dd || !dd.classList.contains('show')) return;
      const totalItems = acItems.length + (showingNewOption() ? 1 : 0);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        acActiveIdx = Math.min(acActiveIdx + 1, totalItems - 1);
        renderAcDropdown(idx, true);
        const el = dd.querySelector('.autocomplete-item.active, .autocomplete-new.active');
        if (el) el.scrollIntoView({block: 'nearest'});
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        acActiveIdx = Math.max(acActiveIdx - 1, 0);
        renderAcDropdown(idx, true);
        const el = dd.querySelector('.autocomplete-item.active, .autocomplete-new.active');
        if (el) el.scrollIntoView({block: 'nearest'});
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const val = input.value.trim();
        if (acActiveIdx >= 0 && acActiveIdx < acItems.length) {
          selectProductForRow(idx, acItems[acActiveIdx], false);
        } else if (acActiveIdx === acItems.length && showingNewOption()) {
          // selected "use this as new"
          selectProductForRow(idx, val, true);
        } else if (acItems.length > 0) {
          selectProductForRow(idx, acItems[0], false);
        } else if (val) {
          // nothing in list — commit as new
          selectProductForRow(idx, val, true);
        }
      } else if (e.key === 'Escape') {
        renderAcDropdown(idx, false);
      }
    });
  });

  productRows.querySelectorAll('.product-row-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      if (productEntries.length <= 1) return;
      productEntries.splice(idx, 1);
      renderProductRows();
      checkSetup();
    });
  });
}

function showingNewOption() {
  // Check if current input value is non-empty and not in master
  if (activeAcRow < 0) return false;
  const val = productEntries[activeAcRow]?.value.trim();
  if (!val) return false;
  return !DATA.products.includes(val);
}

function commitRowValue(idx) {
  const entry = productEntries[idx];
  const val = entry.value.trim();
  if (!val) {
    entry.isValid = false;
    entry.isNew = false;
  } else if (DATA.products.includes(val)) {
    entry.isValid = true;
    entry.isNew = false;
  } else {
    // Non-empty, not in master → accept as new
    entry.isValid = true;
    entry.isNew = true;
  }
  // Re-render to update badge
  const input = productRows.querySelector(`.p-input[data-idx="${idx}"]`);
  if (input) {
    input.className = 'p-input ' + (entry.isValid ? (entry.isNew ? 'valid-new' : 'valid') : '');
    const row = input.closest('.product-row-input');
    const oldBadge = row.querySelector('.product-badge');
    if (oldBadge) oldBadge.remove();
    if (entry.isValid) {
      const badge = document.createElement('span');
      badge.className = 'product-badge ' + (entry.isNew ? 'new' : 'master');
      badge.textContent = entry.isNew ? 'ใหม่' : '✓ MASTER';
      // insert after input
      input.parentNode.insertBefore(badge, input.nextSibling);
    }
  }
  checkSetup();
}

function renderAcDropdown(rowIdx, show) {
  const dd = productRows.querySelector(`.autocomplete-dropdown[data-idx="${rowIdx}"]`);
  if (!dd) return;
  if (!show) {
    dd.classList.remove('show');
    return;
  }
  const input = productRows.querySelector(`.p-input[data-idx="${rowIdx}"]`);
  const q = input.value.trim();
  acItems = filterProducts(q);
  const showNew = q && !DATA.products.includes(q);

  let html = '';
  if (acItems.length === 0) {
    html += '<div class="autocomplete-empty">ไม่พบใน master สินค้า</div>';
  } else {
    html += acItems.map((p, i) =>
      `<div class="autocomplete-item ${i === acActiveIdx ? 'active' : ''}" data-p="${escapeHtml(p)}">${highlightMatch(p, q)}</div>`
    ).join('');
  }
  if (showNew) {
    const newActive = acActiveIdx === acItems.length;
    html += `<div class="autocomplete-new ${newActive ? 'active' : ''}" data-new="1">
      <span class="plus-icon">+</span>ใช้ "${escapeHtml(q)}" เป็นสินค้าใหม่
    </div>`;
  }
  dd.innerHTML = html;
  dd.querySelectorAll('.autocomplete-item').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectProductForRow(rowIdx, el.dataset.p, false);
    });
  });
  dd.querySelectorAll('.autocomplete-new').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectProductForRow(rowIdx, q, true);
    });
  });
  dd.classList.add('show');
}

function selectProductForRow(rowIdx, productName, isNew) {
  productEntries[rowIdx].value = productName;
  productEntries[rowIdx].isValid = true;
  productEntries[rowIdx].isNew = !!isNew;
  renderAcDropdown(rowIdx, false);
  renderProductRows();
  checkSetup();
  const nextInput = productRows.querySelector(`.p-input[data-idx="${rowIdx + 1}"]`);
  if (nextInput) nextInput.focus();
}

btnAddProduct.addEventListener('click', () => {
  productEntries.push({ value: '', isValid: false });
  renderProductRows();
  // focus new row
  setTimeout(() => {
    const inputs = productRows.querySelectorAll('.p-input');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }, 50);
});

// Initial renderProductRows will be called by loadMasterData()

// --- Start button ---
const btnStart = document.getElementById('btn-start');
function getValidProducts() {
  return productEntries.filter(e => e.isValid).map(e => ({ name: e.value, isNew: !!e.isNew }));
}
function checkSetup() {
  const validProducts = getValidProducts();
  btnStart.disabled = !(fDate.value && state.machineId && validProducts.length > 0);
}
fDate.addEventListener('change', checkSetup);

btnStart.addEventListener('click', () => {
  const validProducts = getValidProducts();
  if (validProducts.length === 0) {
    showToast('⚠️ กรุณาเลือกสินค้าอย่างน้อย 1 รายการ', true);
    return;
  }
  state.date = fDate.value;
  state.products = validProducts;  // [{name, isNew}]
  state.currentProductIdx = 0;
  const d = new Date(state.date);
  const dStr = d.toLocaleDateString('th-TH', {day:'2-digit',month:'short',year:'2-digit'});
  document.getElementById('ctx-date').textContent = dStr;
  document.getElementById('ctx-machine').textContent = state.machineName;
  renderProductSelector();
  goToScreen(2);
});

document.getElementById('btn-edit-ctx').addEventListener('click', () => goToScreen(1));

// ========== SCREEN 2: SCANNING ==========
const scanInput = document.getElementById('scan-input');
const scannerBox = document.getElementById('scanner-box');
const quickScan = document.getElementById('quick-scan');

SAMPLE_BARCODES.forEach(bc => {
  const chip = document.createElement('span');
  chip.className = 'quick-chip';
  chip.textContent = bc.length > 22 ? bc.substring(0, 20) + '…' : bc;
  chip.title = bc;
  chip.addEventListener('click', () => {
    scanInput.value = bc;
    handleScan();
  });
  quickScan.appendChild(chip);
});

scanInput.addEventListener('focus', () => scannerBox.classList.add('focused'));
scanInput.addEventListener('blur', () => scannerBox.classList.remove('focused'));

function renderProductSelector() {
  const sel = document.getElementById('product-selector');
  const title = document.getElementById('selector-title');
  const toggleWrapper = document.getElementById('mode-toggle-wrapper');
  if (!sel) return;  // defensive: skip ถ้า DOM ยังไม่พร้อม

  // Show toggle only if there are 2+ products
  if (toggleWrapper) {
    if (state.products.length >= 2) {
      toggleWrapper.style.display = 'flex';
    } else {
      toggleWrapper.style.display = 'none';
      state.sharedMode = true;  // 1 product ก็ shared โดยอัตโนมัติ
    }
  }

  if (state.sharedMode) {
    if (title) {
      title.innerHTML = state.products.length >= 2
        ? '🔗 ม้วนนี้จะบันทึกให้ <strong style="color:var(--accent-2)">ทุกสินค้า</strong> (' + state.products.length + ' สินค้า)'
        : 'กำลังสแกนให้สินค้า:';
    }
    // แสดง tabs แบบอ่านอย่างเดียว (ไม่ active single)
    sel.innerHTML = state.products.map((p, idx) => {
      const count = state.scans.filter(s => s.productIdx === idx).length;
      const newMark = p.isNew ? '<span style="font-size:9px;opacity:0.8;margin-right:4px;">●NEW</span>' : '';
      return `<div class="product-tab" style="cursor:default; background:var(--accent-2-bg); color:var(--accent-2); border:1.5px solid var(--accent-2);">
        ${newMark}${escapeHtml(p.name)} <span class="count" style="background:white;color:var(--accent-2);">${count}</span>
      </div>`;
    }).join('');
  } else {
    if (title) title.textContent = 'กำลังสแกนให้สินค้า:';
    sel.innerHTML = state.products.map((p, idx) => {
      const count = state.scans.filter(s => s.productIdx === idx).length;
      const isActive = idx === state.currentProductIdx;
      const newMark = p.isNew ? '<span style="font-size:9px;opacity:0.8;margin-right:4px;">●NEW</span>' : '';
      return `<button class="product-tab ${isActive ? 'active' : ''}" data-idx="${idx}">
        ${newMark}${escapeHtml(p.name)} <span class="count">${count}</span>
      </button>`;
    }).join('');
    sel.querySelectorAll('.product-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        state.currentProductIdx = parseInt(btn.dataset.idx);
        renderProductSelector();
        setTimeout(() => scanInput.focus(), 50);
      });
    });
  }
}

// Toggle shared/per-product mode
const chkPerProduct = document.getElementById('chk-per-product');
if (chkPerProduct) {
  chkPerProduct.addEventListener('change', () => {
    if (state.scans.length > 0) {
      // มี scan แล้ว — ต้องเตือน
      if (!confirm('การเปลี่ยน mode จะล้างม้วนที่สแกนไปแล้ว ต้องการเปลี่ยน?')) {
        chkPerProduct.checked = !chkPerProduct.checked;  // revert
        return;
      }
      state.scans = [];
    }
    state.sharedMode = !chkPerProduct.checked;
    state.currentProductIdx = 0;
    renderProductSelector();
    renderScans();
  });
}

function handleScan() {
  const raw = scanInput.value.trim();
  if (!raw) return;

  // ตรวจว่ามี barcode หลายตัวติดกันหรือไม่
  const parts = raw.split('_');
  let currentBarcode, remaining = '';

  if (parts.length > 5) {
    // มีมากกว่า 1 barcode — ตัดเฉพาะ 5 ส่วนแรก
    currentBarcode = parts.slice(0, 5).join('_');
    remaining = parts.slice(5).join('_');
  } else {
    currentBarcode = raw;
  }

  // Process barcode แรก
  const wasModalShown = processOneBarcode(currentBarcode);

  // Clear input + ถ้ามี remaining ให้ process ต่อ
  scanInput.value = '';
  if (remaining) {
    if (wasModalShown) {
      // Modal เปิดอยู่ — เก็บ remaining ไว้ ให้ใส่ใหม่หลังปิด modal
      window._pendingBarcode = remaining;
    } else {
      // No modal — process ต่อทันที
      setTimeout(() => {
        scanInput.value = remaining;
        scanInput.dispatchEvent(new Event('input'));
      }, 50);
    }
  }
}

function processOneBarcode(bcRaw) {
  // returns true if error modal was shown

  // 1) Auto-normalize — แก้ case, space, cut_date format
  const normResult = normalizeBarcode(bcRaw);
  const bc = normResult.normalized;

  // แจ้ง toast ว่า normalize แล้ว (ถ้ามีการแก้จริง)
  if (normResult.wasChanged) {
    console.log('Normalized:', bcRaw, '→', bc, '(' + normResult.changes.join(', ') + ')');
  }

  const parsed = parseBarcode(bc);
  const validation = validateBarcode(bc);

  if (!parsed || validation.fatal) {
    const reasons = validation.warnings.length > 0
      ? validation.warnings
      : ['โครงสร้าง Barcode ผิดรูปแบบ'];
    // ถ้ามีการ normalize ก่อนหน้า แต่ยังผิด → โชว์ทั้งต้นฉบับและที่ปรับแล้ว
    if (normResult.wasChanged) {
      reasons.unshift('ปรับแล้ว: ' + bcRaw + ' → ' + bc);
    }
    showErrorModal(bcRaw, reasons);
    return true;  // modal was shown
  }

  const scanId = Date.now() + Math.random();
  if (state.sharedMode) {
    // Shared mode (default): ม้วนนี้ใส่ให้ทุกสินค้า
    state.products.forEach((product, idx) => {
      state.scans.push({
        id: scanId + (idx * 0.0001),  // unique id per product
        barcode: bc,
        productIdx: idx,
        productName: product.name,
        productIsNew: product.isNew,
        valid: validation.valid,
        warnings: validation.warnings,
        ...parsed
      });
    });
    const label = state.products.length === 1
      ? state.products[0].name
      : `${state.products.length} สินค้า`;
    const normSuffix = normResult.wasChanged ? ' 🔧' : '';
    if (validation.valid) {
      showToast('✓ ' + label + ' · ' + parsed.paper_type + normSuffix);
      playBeep('success');
    } else {
      showToast('⚠️ บันทึกแล้ว (' + label + ') แต่ผิด format: ' + validation.warnings[0], 'warning');
      playBeep('warning');
    }
  } else {
    // Per-product mode: ม้วนเข้าเฉพาะสินค้าที่เลือก
    const currentProduct = state.products[state.currentProductIdx];
    state.scans.push({
      id: scanId,
      barcode: bc,
      productIdx: state.currentProductIdx,
      productName: currentProduct.name,
      productIsNew: currentProduct.isNew,
      valid: validation.valid,
      warnings: validation.warnings,
      ...parsed
    });
    const normSuffix = normResult.wasChanged ? ' 🔧' : '';
    if (validation.valid) {
      showToast('✓ ' + currentProduct.name + ' · ' + parsed.paper_type + normSuffix);
      playBeep('success');
    } else {
      showToast('⚠️ บันทึกแล้ว แต่ Barcode ผิด format: ' + validation.warnings[0], 'warning');
      playBeep('warning');
    }
  }

  renderScans();
  renderProductSelector();
  return false;  // no modal
}

scanInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); handleScan(); }
});

let scanTimer;
let scanIdleTimer;
scanInput.addEventListener('input', () => {
  clearTimeout(scanTimer);
  clearTimeout(scanIdleTimer);
  const v = scanInput.value.trim();
  if (!v) return;

  const underscoreCount = (v.match(/_/g) || []).length;

  // ถ้ามี _ ครบ 4 ตัวขึ้นไป = มี barcode อย่างน้อย 1 ตัวที่ครบรูปแบบ
  // → submit ทันที (handleScan จะจัดการเก็บส่วนเกินไว้ให้เอง)
  if (underscoreCount >= 4) {
    scanTimer = setTimeout(handleScan, 80);
    return;
  }

  // ถ้า _ น้อยกว่า 4 → รอ 200ms ดูว่ามี barcode เข้ามาอีกไหม
  // ถ้าไม่มี → ถือว่าผิดรูปแบบ → handleScan จะเด้ง modal
  scanIdleTimer = setTimeout(() => {
    if (scanInput.value.trim() === v) {
      handleScan();
    }
  }, 200);
});

function renderScans() {
  const list = document.getElementById('scan-list');
  document.getElementById('scan-count').textContent = state.scans.length;
  document.getElementById('btn-review').disabled = state.scans.length === 0;

  if (state.scans.length === 0) {
    list.innerHTML = '<div class="empty-scans">ยังไม่มีม้วนที่สแกน — ยิง QR ข้างบนได้เลย</div>';
    return;
  }

  list.innerHTML = state.scans.slice().reverse().map((s, idx) => {
    const n = state.scans.length - idx;
    const warningBadge = !s.valid && s.warnings && s.warnings.length > 0
      ? `<span style="display:inline-block;padding:2px 6px;background:#fef3c7;color:#92400e;border-radius:4px;font-size:11px;font-weight:700;margin-right:4px;" title="${escapeHtml(s.warnings.join(' · '))}">⚠️ ผิด format</span>`
      : '';
    return `<div class="scan-item" style="${!s.valid ? 'border-left-color: #d97706;' : ''}">
      <div class="scan-item-num">${n}</div>
      <div class="scan-item-info">
        <div class="scan-item-barcode">${escapeHtml(s.barcode)}</div>
        <div class="scan-item-meta">
          ${warningBadge}<span class="tag">${escapeHtml(s.paper_type)}</span>
          <span style="color:var(--accent-2);font-weight:600;">→ ${escapeHtml(s.productName)}</span>
          · ล็อต ${escapeHtml(s.jumbo_lot)} · Slitter ${escapeHtml(s.slitter)}
        </div>
      </div>
      <button class="scan-item-del" data-id="${s.id}" title="ลบ">✕</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.scan-item-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseFloat(btn.dataset.id);
      state.scans = state.scans.filter(s => s.id !== id);
      renderScans();
      renderProductSelector();
      showToast('ลบแล้ว', true);
    });
  });
}

document.getElementById('btn-clear').addEventListener('click', () => {
  if (state.scans.length === 0) return;
  if (confirm('ลบรายการสแกนทั้งหมด?')) {
    state.scans = [];
    renderScans();
  }
});

document.getElementById('btn-review').addEventListener('click', () => {
  renderReview();
  goToScreen(3);
});

// ========== SCREEN 3: REVIEW ==========
function renderReview() {
  const d = new Date(state.date);
  document.getElementById('rv-date').textContent =
    d.toLocaleDateString('th-TH', {day:'2-digit',month:'short',year:'2-digit'});
  document.getElementById('rv-machine').textContent = state.machineName;
  document.getElementById('rv-product').textContent = state.products.map(p => p.name + (p.isNew ? ' (ใหม่)' : '')).join(', ');

  // Group by product -> paper_type -> jumbo_lot
  const byProduct = {};
  state.scans.forEach(s => {
    if (!byProduct[s.productName]) byProduct[s.productName] = {};
    if (!byProduct[s.productName][s.paper_type]) byProduct[s.productName][s.paper_type] = {};
    const key = s.jumbo_lot;
    if (!byProduct[s.productName][s.paper_type][key]) {
      byProduct[s.productName][s.paper_type][key] = { count: 0, cut_date: s.cut_date, slitter: s.slitter };
    }
    byProduct[s.productName][s.paper_type][key].count++;
  });

  const totalTypes = new Set(state.scans.map(s => s.paper_type)).size;
  const totalRolls = state.scans.length;
  const totalLots = new Set(state.scans.map(s => s.jumbo_lot)).size;

  document.getElementById('rv-types').textContent = totalTypes;
  document.getElementById('rv-rolls').textContent = totalRolls;
  document.getElementById('rv-lots').textContent = totalLots;

  // Show warning if there are invalid barcodes
  const invalidCount = state.scans.filter(s => s.valid === false).length;
  let invalidBanner = '';
  if (invalidCount > 0) {
    invalidBanner = `<div style="padding: 14px 16px; background: #fef3c7; border-left: 4px solid #d97706; border-radius: 8px; margin-bottom: 16px; color: #78350f; font-size: 14px;">
      <strong>⚠️ มี ${invalidCount} Barcode ที่ผิด format</strong><br>
      <span style="font-size: 12px;">ระบบจะบันทึกให้ แต่ mark ไว้ใน DB เพื่อให้ตรวจสอบภายหลัง</span>
    </div>`;
  }
  const container = document.getElementById('rv-groups');
  container.innerHTML = invalidBanner;
  // Sort products by scan count desc
  const sortedProducts = Object.entries(byProduct).sort((a, b) => {
    const countA = state.scans.filter(s => s.productName === a[0]).length;
    const countB = state.scans.filter(s => s.productName === b[0]).length;
    return countB - countA;
  });

  container.innerHTML += sortedProducts.map(([productName, types]) => {
    const productRolls = state.scans.filter(s => s.productName === productName).length;
    const isProductNew = state.scans.find(s => s.productName === productName)?.productIsNew;
    const sortedTypes = Object.entries(types).sort((a,b) => {
      const sumA = Object.values(a[1]).reduce((s,v) => s+v.count, 0);
      const sumB = Object.values(b[1]).reduce((s,v) => s+v.count, 0);
      return sumB - sumA;
    });

    const typesHtml = sortedTypes.map(([type, lots]) => {
      const totalForType = Object.values(lots).reduce((s,v) => s+v.count, 0);
      const sortedLots = Object.entries(lots).sort((a,b) => b[1].count - a[1].count);
      return `<div style="margin-bottom: 10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;font-size:13px;">
          <strong style="color:var(--accent-2)">${escapeHtml(type)}</strong>
          <span style="color:var(--text-dim);font-size:11px;">${Object.keys(lots).length} lots · ${totalForType} ม้วน</span>
        </div>
        ${sortedLots.map(([lot, info]) => `
          <div class="summary-roll">
            <div>
              <strong>${escapeHtml(lot)}</strong>
              <span style="color:var(--text-dim)"> · ตัด ${escapeHtml(info.cut_date)} · Slitter ${escapeHtml(info.slitter)}</span>
            </div>
            <div class="summary-roll-count">${info.count}×</div>
          </div>
        `).join('')}
      </div>`;
    }).join('');

    return `<div class="summary-group" style="border: 2px solid var(--accent); padding: 16px;">
      <div class="summary-group-title" style="border-bottom: 1px solid var(--accent-bg); padding-bottom: 8px; margin-bottom: 12px;">
        <span style="color:var(--accent); font-size: 15px;">
          📦 ${escapeHtml(productName)}
          ${isProductNew ? '<span style="background:var(--accent-2-bg);color:var(--accent-2);font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px;font-weight:700;">ใหม่</span>' : ''}
        </span>
        <span>${productRolls} ม้วน</span>
      </div>
      ${typesHtml}
    </div>`;
  }).join('');
}

document.getElementById('btn-back').addEventListener('click', () => goToScreen(2));

// ==================== SUPABASE INTEGRATION ====================

function showLoading(text) {
  document.getElementById('loading-text').textContent = text || 'กำลังโหลด...';
  document.getElementById('loading-overlay').classList.add('show');
}
function hideLoading() {
  document.getElementById('loading-overlay').classList.remove('show');
}
function setConnStatus(online, label) {
  const el = document.getElementById('conn-status');
  el.classList.toggle('online', online);
  el.classList.toggle('offline', !online);
  document.getElementById('conn-label').textContent = label;
}

// --- Load master data from Supabase on page load ---
async function loadMasterData() {
  showLoading('กำลังโหลดข้อมูลเครื่องและสินค้า...');
  try {
    const [machinesRes, productsRes] = await Promise.all([
      supabase.from('machines').select('id, name, dp').eq('is_active', true).order('id'),
      supabase.from('products').select('product_name').eq('is_active', true).order('product_name')
    ]);

    if (machinesRes.error) throw machinesRes.error;
    if (productsRes.error) throw productsRes.error;

    DATA.machines = machinesRes.data || [];
    DATA.products = (productsRes.data || []).map(r => r.product_name);

    setConnStatus(true, `✓ ${DATA.machines.length} เครื่อง · ${DATA.products.length} สินค้า`);

    // Now render the UI
    renderDpTabs();
    renderMachineGrid();
    renderProductRows();
  } catch (err) {
    console.error('Failed to load master data:', err);
    setConnStatus(false, '✗ เชื่อมต่อ DB ไม่ได้');
    showToast('⚠️ โหลดข้อมูลไม่สำเร็จ: ' + (err.message || err), true);
  } finally {
    hideLoading();
  }
}

// --- Submit batch to Supabase ---
async function submitBatch() {
  showLoading('กำลังบันทึกข้อมูล...');
  try {
    // Step 1: Insert production_batch
    const { data: batch, error: batchErr } = await supabase
      .from('production_batches')
      .insert({
        production_date: state.date,
        machine_id: state.machineId,
      })
      .select()
      .single();
    if (batchErr) throw batchErr;

    // Step 2: Insert batch_products (and get their IDs)
    const productsToInsert = state.products.map((p, i) => ({
      batch_id: batch.id,
      product_name: p.name,
      is_new_product: !!p.isNew,
      sequence: i + 1
    }));
    const { data: batchProducts, error: bpErr } = await supabase
      .from('batch_products')
      .insert(productsToInsert)
      .select();
    if (bpErr) throw bpErr;

    // Step 3: Insert paper_scans (bulk)
    const scansToInsert = state.scans.map(s => {
      const bp = batchProducts[s.productIdx];
      return {
        batch_id: batch.id,
        batch_product_id: bp.id,
        barcode_raw: s.barcode,
        paper_type: s.paper_type,
        cut_date: s.cut_date,
        roll_no: s.roll_no,
        slitter: s.slitter,
        jumbo_lot: s.jumbo_lot,
        barcode_valid: s.valid !== false,
        barcode_warnings: (s.warnings && s.warnings.length > 0) ? s.warnings.join(' | ') : null
      };
    });
    const { error: scanErr } = await supabase
      .from('paper_scans')
      .insert(scansToInsert);
    if (scanErr) throw scanErr;

    // Step 4: If there are new products, add them to master
    const newProducts = state.products.filter(p => p.isNew).map(p => ({ product_name: p.name }));
    if (newProducts.length > 0) {
      // Use upsert with ignoreDuplicates to avoid conflict if added by another user
      await supabase.from('products').upsert(newProducts, { onConflict: 'product_name', ignoreDuplicates: true });
      // Update local master so subsequent entries recognize them
      newProducts.forEach(np => {
        if (!DATA.products.includes(np.product_name)) DATA.products.push(np.product_name);
      });
    }

    // Success
    document.getElementById('sc-count').textContent = state.scans.length;
    hideLoading();
    goToScreen(4);
  } catch (err) {
    console.error('Submit failed:', err);
    hideLoading();
    showToast('⚠️ บันทึกไม่สำเร็จ: ' + (err.message || err), true);
  }
}

document.getElementById('btn-submit').addEventListener('click', submitBatch);

// Load master data on page load
loadMasterData();

document.getElementById('btn-new').addEventListener('click', () => {
  state.scans = [];
  state.machineId = null;
  state.machineName = '';
  state.dp = '';
  state.products = [];
  state.currentProductIdx = 0;
  productEntries = [{ value: '', isValid: false }];
  fDate.valueAsDate = new Date();
  document.getElementById('machine-hint').textContent = 'เลือกแผนกก่อน';
  renderMachineGrid();
  renderProductRows();
  checkSetup();
  renderScans();
  goToScreen(1);
});
