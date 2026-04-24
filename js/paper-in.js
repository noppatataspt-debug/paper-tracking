/* ============================================================
   Paper-In — Main Logic
   ============================================================
   Features:
   - Tab switching
   - Upload & auto-parse (SCG, MPK, United, Muda)
   - Manual form entry
   - List view with search/filter
   - Save to Supabase
   ============================================================ */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import {
  parseSCG_TXT,
  parseSCG_COA,
  parseMPK_CSV,
  parseUnited_XLSX,
  parseMuda_XLS,
  detectSupplier,
  normalizeLot,
} from './parsers.js';

// ============================================================
// Config (ใช้ key เดียวกับระบบเดิม)
// ============================================================
const SUPABASE_URL = 'https://lfrwghrlxaordpxrqyij.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxmcndnaHJseGFvcmRweHJxeWlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4MzQ5MjgsImV4cCI6MjA5MjQxMDkyOH0.M13hI5TUqEL8iVmGM3pWcjbyULSx_n7VPgI2TcHnNZA';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// State
// ============================================================
const state = {
  suppliers: [],
  paperTypes: [],
  parsedInvoices: [],   // for upload tab
  manualRolls: [],      // for manual tab
  listData: [],         // for list tab
  listPage: 1,
  listPerPage: 50,
};

// ============================================================
// Utils
// ============================================================
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showToast(msg, type = 'success') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => t.className = 'toast', 3500);
}

function showLoading(text = 'กำลังโหลด...') {
  $('#loading-text').textContent = text;
  $('#loading-overlay').classList.add('show');
}
function hideLoading() {
  $('#loading-overlay').classList.remove('show');
}

function formatNumber(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Read file as text
function readAsText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsText(file, 'UTF-8');
  });
}

// Read file as ArrayBuffer (for xlsx)
function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsArrayBuffer(file);
  });
}

// ============================================================
// Master Data Loading
// ============================================================
async function loadMasterData() {
  try {
    const [sp, pt] = await Promise.all([
      supabase.from('suppliers').select('*').eq('is_active', true).order('name'),
      supabase.from('paper_types').select('*').eq('is_active', true).order('paper_type'),
    ]);
    
    state.suppliers = sp.data || [];
    state.paperTypes = pt.data || [];

    // Populate dropdowns
    const supplierSel = $('#m-supplier');
    supplierSel.innerHTML = '<option value="">-- เลือก Supplier --</option>' +
      state.suppliers.map(s => `<option value="${escapeHtml(s.code)}">${escapeHtml(s.name)}</option>`).join('');

    const filterSupp = $('#l-filter-supplier');
    filterSupp.innerHTML = '<option value="">ทุก Supplier</option>' +
      state.suppliers.map(s => `<option value="${escapeHtml(s.code)}">${escapeHtml(s.name)}</option>`).join('');

    setConnStatus(true);
  } catch (e) {
    console.error(e);
    showToast('โหลดข้อมูลไม่ได้: ' + e.message, 'error');
    setConnStatus(false);
  }
}

function setConnStatus(online) {
  const el = $('#conn-status');
  const txt = $('#conn-text');
  if (online) {
    el.className = 'conn-status online';
    txt.textContent = 'เชื่อมต่อ DB';
  } else {
    el.className = 'conn-status offline';
    txt.textContent = 'ออฟไลน์';
  }
}

// ============================================================
// Tabs
// ============================================================
function setupTabs() {
  $$('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab').forEach(b => b.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const tabName = btn.dataset.tab;
      $('#tab-' + tabName).classList.add('active');
      
      if (tabName === 'list') loadList();
    });
  });
}

// ============================================================
// TAB 1: UPLOAD
// ============================================================
function setupUpload() {
  const zone = $('#upload-zone');
  const input = $('#file-input');
  
  zone.addEventListener('click', () => input.click());
  
  zone.addEventListener('dragover', e => {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });
  
  input.addEventListener('change', e => handleFiles(e.target.files));
}

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  
  showLoading(`กำลังแกะไฟล์ ${files.length} ไฟล์...`);
  
  // Group SCG COA with matching TXT (same invoice number)
  const scgTxtByInv = {};  // invoice_no → parsed result
  const scgCoaByInv = {};  // invoice_no → coa list
  
  for (const file of files) {
    try {
      const supplier = detectSupplier(file.name, '');
      const result = await parseFile(file, supplier);
      
      if (!result) {
        addInvoiceCard({
          filename: file.name,
          supplier: 'Unknown',
          error: 'ไม่รู้จัก format ของไฟล์นี้',
          status: 'err',
        });
        continue;
      }
      
      // ถ้าเป็น SCG COA → เก็บไว้ merge ทีหลัง
      if (supplier === 'SCG_COA') {
        // Match โดย invoice_no (จากชื่อไฟล์)
        const m = file.name.match(/05\d{8}/);
        const invKey = m ? m[0] : file.name;
        scgCoaByInv[invKey] = { filename: file.name, coa: result };
        continue;
      }
      
      // ถ้าเป็น SCG TXT → เก็บไว้ merge กับ COA
      if (supplier === 'SCG_TXT') {
        result.filename = file.name;
        scgTxtByInv[result.data.invoice_no] = result;
        continue;
      }
      
      // ไม่ใช่ SCG → เพิ่มเข้า list ปกติ
      result.filename = file.name;
      state.parsedInvoices.push(result);
      addInvoiceCard(result);
    } catch (e) {
      console.error(e);
      addInvoiceCard({
        filename: file.name,
        supplier: 'Error',
        error: e.message,
        status: 'err',
      });
    }
  }
  
  // Merge SCG TXT + COA
  for (const invNo of Object.keys(scgTxtByInv)) {
    const txt = scgTxtByInv[invNo];
    const coa = scgCoaByInv[invNo];
    if (coa) {
      // แนบ COA ให้แต่ละม้วน
      const coaMap = {};
      coa.coa.forEach(c => coaMap[c.paper_lot_normalized] = c.coa);
      txt.data.rolls.forEach(r => {
        if (coaMap[r.paper_lot_normalized]) r.coa = coaMap[r.paper_lot_normalized];
      });
      txt.hasCoa = true;
    }
    state.parsedInvoices.push(txt);
    addInvoiceCard(txt);
  }
  // SCG COA อย่างเดียว (ไม่มี TXT matching) → เตือน
  for (const invNo of Object.keys(scgCoaByInv)) {
    if (!scgTxtByInv[invNo]) {
      addInvoiceCard({
        filename: scgCoaByInv[invNo].filename,
        supplier: 'SCG COA',
        warning: `ไฟล์ COA (${invNo}) ไม่พบ TXT คู่กัน — กรุณา upload ไฟล์ .txt ด้วย`,
        status: 'warn',
      });
    }
  }
  
  hideLoading();
}

async function parseFile(file, supplier) {
  if (supplier === 'SCG_TXT') {
    const text = await readAsText(file);
    const data = parseSCG_TXT(text);
    return { supplier: 'SCG', data, status: 'ok' };
  }
  
  if (supplier === 'SCG_COA') {
    const buf = await readAsArrayBuffer(file);
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    return parseSCG_COA(rows);  // return array directly (merged later)
  }
  
  if (supplier === 'MPK_CSV') {
    const text = await readAsText(file);
    const data = parseMPK_CSV(text);
    return { supplier: 'MPK', data, status: 'ok' };
  }
  
  if (supplier === 'United_XLSX') {
    const buf = await readAsArrayBuffer(file);
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const data = parseUnited_XLSX(rows);
    return { supplier: 'United', data, status: 'ok' };
  }
  
  if (supplier === 'Muda_XLS') {
    const buf = await readAsArrayBuffer(file);
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const data = parseMuda_XLS(rows);
    return { supplier: 'Muda', data, status: 'ok' };
  }
  
  return null;
}

function addInvoiceCard(result) {
  const container = $('#parsed-invoices');
  
  // Error card
  if (result.error) {
    const div = document.createElement('div');
    div.className = 'inv-card err';
    div.innerHTML = `
      <div class="inv-card-header">
        <div class="inv-card-title">
          <span>❌ ${escapeHtml(result.supplier)}</span>
          <span class="filename">${escapeHtml(result.filename)}</span>
        </div>
        <span class="inv-status err">Error</span>
      </div>
      <div style="color:var(--danger); font-size:14px;">${escapeHtml(result.error)}</div>
    `;
    container.appendChild(div);
    return;
  }
  
  // Warning card
  if (result.warning) {
    const div = document.createElement('div');
    div.className = 'inv-card warn';
    div.innerHTML = `
      <div class="inv-card-header">
        <div class="inv-card-title">
          <span>⚠️ ${escapeHtml(result.supplier)}</span>
          <span class="filename">${escapeHtml(result.filename)}</span>
        </div>
        <span class="inv-status warn">Warning</span>
      </div>
      <div style="color:var(--warning); font-size:14px;">${escapeHtml(result.warning)}</div>
    `;
    container.appendChild(div);
    return;
  }
  
  // Success card
  const d = result.data;
  const totalWeight = d.rolls.reduce((s, r) => s + (r.weight_kg || 0), 0);
  const uniqueTypes = [...new Set(d.rolls.map(r => r.paper_type))];
  
  const idx = state.parsedInvoices.length - 1;
  
  const div = document.createElement('div');
  div.className = 'inv-card ok';
  div.dataset.idx = idx;
  div.innerHTML = `
    <div class="inv-card-header">
      <div class="inv-card-title">
        <span>✅ ${escapeHtml(result.supplier)}${result.hasCoa ? ' + COA' : ''}</span>
        <span class="filename">${escapeHtml(result.filename)}</span>
      </div>
      <span class="inv-status ok">${d.rolls.length} ม้วน</span>
    </div>
    <div class="inv-meta">
      <div class="inv-meta-item">
        <div class="label">Invoice</div>
        <div class="value">${escapeHtml(d.invoice_no || '—')}</div>
      </div>
      <div class="inv-meta-item">
        <div class="label">วันที่</div>
        <div class="value">${escapeHtml(d.invoice_date || '—')}</div>
      </div>
      <div class="inv-meta-item">
        <div class="label">PO</div>
        <div class="value">${escapeHtml(d.po_no || '—')}</div>
      </div>
      <div class="inv-meta-item">
        <div class="label">น้ำหนักรวม</div>
        <div class="value">${formatNumber(totalWeight)} kg</div>
      </div>
    </div>
    <div class="inv-rolls-summary">
      <div>📦 <strong>${d.rolls.length}</strong> ม้วน · <strong>${uniqueTypes.length}</strong> ประเภท (${escapeHtml(uniqueTypes.join(', '))})</div>
    </div>
    <div class="inv-rolls-table">
      <table>
        <thead>
          <tr>
            <th>Lot</th>
            <th>ประเภท</th>
            <th>กว้าง (mm)</th>
            <th>น้ำหนัก (kg)</th>
          </tr>
        </thead>
        <tbody>
          ${d.rolls.map(r => `
            <tr>
              <td class="mono">${escapeHtml(r.paper_lot)}</td>
              <td class="mono">${escapeHtml(r.paper_type)}</td>
              <td class="mono">${r.width_mm || '—'}</td>
              <td class="mono">${formatNumber(r.weight_kg)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div class="inv-card-actions">
      <label style="font-size:13px; margin-right:auto; display:flex; align-items:center; gap:6px;">
        วันที่รับเข้า:
        <input type="date" class="receive-date" value="${today()}" style="padding:4px 8px; font-size:13px;">
      </label>
      <button class="btn btn-sm btn-danger remove-btn">🗑️ ลบ</button>
      <button class="btn btn-sm btn-primary save-btn">💾 บันทึก</button>
    </div>
  `;
  
  container.appendChild(div);
  
  // Attach handlers
  div.querySelector('.save-btn').addEventListener('click', () => {
    const receiveDate = div.querySelector('.receive-date').value;
    saveInvoice(idx, receiveDate, result.filename);
  });
  div.querySelector('.remove-btn').addEventListener('click', () => {
    div.remove();
    state.parsedInvoices[idx] = null;
  });
}

// ============================================================
// SAVE Invoice to Database
// ============================================================
async function saveInvoice(idx, receiveDate, sourceFile) {
  const result = state.parsedInvoices[idx];
  if (!result) { showToast('ไม่พบข้อมูล', 'error'); return; }
  
  const d = result.data;
  if (!d.rolls.length) { showToast('ไม่มีม้วนให้บันทึก', 'error'); return; }
  if (!receiveDate) { showToast('กรุณาเลือกวันที่รับเข้า', 'error'); return; }
  
  showLoading('กำลังบันทึก...');
  
  try {
    // เตรียมข้อมูล rolls สำหรับ bulk insert
    const rollsToInsert = d.rolls.map(r => ({
      paper_lot: r.paper_lot,
      paper_lot_normalized: r.paper_lot_normalized,
      paper_type: r.paper_type,
      invoice_no: d.invoice_no,
      supplier: result.supplier,
      invoice_date: d.invoice_date || null,
      receive_date: receiveDate,
      width_mm: r.width_mm || null,
      weight_kg: r.weight_kg,
      po_no: d.po_no || null,
      source_file: sourceFile,
      status: 'in_stock',
      remaining_weight_kg: r.weight_kg,
    }));
    
    // ตรวจ lot ซ้ำ
    const lots = rollsToInsert.map(r => r.paper_lot_normalized);
    const { data: existing } = await supabase
      .from('paper_invoices')
      .select('paper_lot_normalized')
      .in('paper_lot_normalized', lots);
    
    const existingSet = new Set((existing || []).map(e => e.paper_lot_normalized));
    const duplicates = rollsToInsert.filter(r => existingSet.has(r.paper_lot_normalized));
    
    if (duplicates.length) {
      hideLoading();
      const dupList = duplicates.slice(0, 5).map(r => r.paper_lot).join(', ');
      const more = duplicates.length > 5 ? ` (และอีก ${duplicates.length - 5} ม้วน)` : '';
      if (!confirm(`พบ lot ซ้ำ ${duplicates.length} ม้วน:\n${dupList}${more}\n\nข้าม ${duplicates.length} ม้วนนี้และบันทึก ${rollsToInsert.length - duplicates.length} ม้วนที่เหลือ?`)) {
        return;
      }
      showLoading('กำลังบันทึก...');
    }
    
    const newRolls = rollsToInsert.filter(r => !existingSet.has(r.paper_lot_normalized));
    if (!newRolls.length) {
      hideLoading();
      showToast('ไม่มีม้วนใหม่ให้บันทึก (ซ้ำทั้งหมด)', 'warning');
      return;
    }
    
    // Insert into paper_invoices
    const { data: inserted, error: insErr } = await supabase
      .from('paper_invoices')
      .insert(newRolls)
      .select('id, paper_lot_normalized');
    
    if (insErr) throw insErr;
    
    // ถ้ามี COA → บันทึกใน quality_tests
    if (result.hasCoa || d.rolls.some(r => r.coa)) {
      const invoiceIdByLot = {};
      (inserted || []).forEach(i => invoiceIdByLot[i.paper_lot_normalized] = i.id);
      
      const qaRecords = [];
      d.rolls.forEach(r => {
        if (r.coa && invoiceIdByLot[r.paper_lot_normalized]) {
          qaRecords.push({
            scope: 'roll',
            paper_invoice_id: invoiceIdByLot[r.paper_lot_normalized],
            invoice_no: d.invoice_no,
            supplier: result.supplier,
            production_date: r.coa.production_date || null,
            basis_weight: r.coa.basis_weight || null,
            burst: r.coa.burst || null,
            plybond: r.coa.plybond || null,
            cobb_top: r.coa.cobb_top || null,
            cobb_bottom: r.coa.cobb_bottom || null,
            caliper: r.coa.caliper || null,
            moisture: r.coa.moisture || null,
            raw_data: r.coa,
          });
        }
      });
      
      if (qaRecords.length) {
        const { error: qaErr } = await supabase.from('quality_tests').insert(qaRecords);
        if (qaErr) console.warn('QA save error (non-fatal):', qaErr);
      }
    }
    
    hideLoading();
    showToast(`✅ บันทึก ${newRolls.length} ม้วนสำเร็จ`, 'success');
    
    // Remove card
    const card = document.querySelector(`.inv-card[data-idx="${idx}"]`);
    if (card) card.remove();
    state.parsedInvoices[idx] = null;
    
  } catch (e) {
    hideLoading();
    console.error(e);
    showToast('บันทึกไม่ได้: ' + (e.message || e), 'error');
  }
}

// ============================================================
// TAB 2: MANUAL
// ============================================================
function setupManual() {
  $('#m-receive-date').value = today();
  $('#m-add-roll').addEventListener('click', addManualRoll);
  $('#m-clear').addEventListener('click', clearManual);
  $('#m-save').addEventListener('click', saveManual);
  
  // เพิ่มม้วนแรกเมื่อเริ่ม
  addManualRoll();
}

function addManualRoll() {
  const rollIdx = state.manualRolls.length;
  state.manualRolls.push({});
  
  const div = document.createElement('div');
  div.className = 'roll-item';
  div.dataset.idx = rollIdx;
  
  const typeOptions = '<option value="">-- เลือก --</option>' +
    state.paperTypes.map(pt => `<option value="${escapeHtml(pt.paper_type)}">${escapeHtml(pt.paper_type)}</option>`).join('');
  
  div.innerHTML = `
    <div class="roll-item-header">
      <span class="roll-number">ม้วน #${rollIdx + 1}</span>
      <button class="btn btn-icon btn-danger m-roll-del" title="ลบม้วนนี้">🗑️</button>
    </div>
    <div class="form-grid">
      <div class="form-group">
        <label>Paper Lot <span class="required">*</span></label>
        <input type="text" class="mono m-lot" placeholder="e.g. 9L4574">
      </div>
      <div class="form-group">
        <label>ประเภท <span class="required">*</span></label>
        <select class="m-type">${typeOptions}</select>
      </div>
      <div class="form-group">
        <label>กว้าง (mm)</label>
        <input type="number" class="m-width" placeholder="1860">
      </div>
      <div class="form-group">
        <label>น้ำหนัก (kg) <span class="required">*</span></label>
        <input type="number" class="m-weight" placeholder="1269" step="0.01">
      </div>
    </div>
  `;
  
  $('#m-rolls-list').appendChild(div);
  
  div.querySelector('.m-roll-del').addEventListener('click', () => {
    div.remove();
    state.manualRolls[rollIdx] = null;
    updateManualSummary();
  });
  
  div.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('input', updateManualSummary);
  });
  
  updateManualSummary();
}

function updateManualSummary() {
  const items = $$('.roll-item');
  let count = 0, totalWeight = 0;
  items.forEach(it => {
    const w = parseFloat(it.querySelector('.m-weight').value);
    if (!isNaN(w)) { count++; totalWeight += w; }
    else count++; // count rolls even without weight
  });
  $('#m-rolls-count').textContent = items.length;
  $('#m-total-rolls').textContent = items.length;
  $('#m-total-weight').textContent = formatNumber(totalWeight);
}

function clearManual() {
  if (!confirm('ล้างข้อมูลทั้งหมด?')) return;
  state.manualRolls = [];
  $('#m-rolls-list').innerHTML = '';
  $('#m-supplier').value = '';
  $('#m-invoice-no').value = '';
  $('#m-po-no').value = '';
  $('#m-invoice-date').value = '';
  $('#m-receive-date').value = today();
  $('#m-notes').value = '';
  addManualRoll();
}

async function saveManual() {
  const supplier = $('#m-supplier').value.trim();
  const invoiceNo = $('#m-invoice-no').value.trim();
  const invoiceDate = $('#m-invoice-date').value || null;
  const receiveDate = $('#m-receive-date').value;
  const poNo = $('#m-po-no').value.trim() || null;
  const notes = $('#m-notes').value.trim() || null;
  
  if (!supplier) { showToast('กรุณาเลือก Supplier', 'error'); return; }
  if (!invoiceNo) { showToast('กรุณาใส่เลข Invoice', 'error'); return; }
  if (!receiveDate) { showToast('กรุณาเลือกวันที่รับเข้า', 'error'); return; }
  
  // เก็บข้อมูลม้วน
  const items = $$('.roll-item');
  if (!items.length) { showToast('ไม่มีม้วนให้บันทึก', 'error'); return; }
  
  const rolls = [];
  for (const it of items) {
    const lot = it.querySelector('.m-lot').value.trim();
    const type = it.querySelector('.m-type').value.trim();
    const width = parseFloat(it.querySelector('.m-width').value) || null;
    const weight = parseFloat(it.querySelector('.m-weight').value);
    
    if (!lot || !type || isNaN(weight)) {
      showToast('กรุณากรอกข้อมูลทุกม้วนให้ครบ (lot, ประเภท, น้ำหนัก)', 'error');
      return;
    }
    
    rolls.push({
      paper_lot: lot,
      paper_lot_normalized: normalizeLot(lot),
      paper_type: type,
      invoice_no: invoiceNo,
      supplier,
      invoice_date: invoiceDate,
      receive_date: receiveDate,
      width_mm: width,
      weight_kg: weight,
      po_no: poNo,
      notes,
      source_file: 'manual',
      status: 'in_stock',
      remaining_weight_kg: weight,
    });
  }
  
  showLoading('กำลังบันทึก...');
  
  try {
    // ตรวจ lot ซ้ำ
    const lots = rolls.map(r => r.paper_lot_normalized);
    const { data: existing } = await supabase
      .from('paper_invoices')
      .select('paper_lot_normalized')
      .in('paper_lot_normalized', lots);
    
    if (existing && existing.length) {
      hideLoading();
      const dups = existing.map(e => e.paper_lot_normalized).join(', ');
      showToast(`❌ พบ lot ซ้ำ ${existing.length} ม้วน: ${dups}`, 'error');
      return;
    }
    
    const { error } = await supabase.from('paper_invoices').insert(rolls);
    if (error) throw error;
    
    hideLoading();
    showToast(`✅ บันทึก ${rolls.length} ม้วนสำเร็จ`, 'success');
    clearManual();
  } catch (e) {
    hideLoading();
    console.error(e);
    showToast('บันทึกไม่ได้: ' + (e.message || e), 'error');
  }
}

// ============================================================
// TAB 3: LIST
// ============================================================
async function loadList() {
  const tbody = $('#l-tbody');
  tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:40px; color:var(--text-dim)">กำลังโหลด...</td></tr>';
  
  try {
    const search = $('#l-search').value.trim();
    const filterSupp = $('#l-filter-supplier').value;
    const filterStatus = $('#l-filter-status').value;
    
    let q = supabase.from('paper_invoices')
      .select('*', { count: 'exact' })
      .order('receive_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range((state.listPage - 1) * state.listPerPage, state.listPage * state.listPerPage - 1);
    
    if (filterSupp) q = q.eq('supplier', filterSupp);
    if (filterStatus) q = q.eq('status', filterStatus);
    if (search) {
      q = q.or(`paper_lot.ilike.%${search}%,paper_lot_normalized.ilike.%${search.replace(/-/g,'').toUpperCase()}%,invoice_no.ilike.%${search}%,supplier.ilike.%${search}%`);
    }
    
    const { data, count, error } = await q;
    if (error) throw error;
    
    state.listData = data || [];
    $('#list-count').textContent = count ? count.toLocaleString() : '0';
    renderListTable(data || [], count || 0);
  } catch (e) {
    console.error(e);
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:var(--danger); padding:20px">โหลดไม่ได้: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderListTable(rows, totalCount) {
  const tbody = $('#l-tbody');
  
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:40px; color:var(--text-dim)">ไม่พบข้อมูล</td></tr>';
    $('#l-pagination').innerHTML = '';
    return;
  }
  
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.receive_date || '—')}</td>
      <td class="td-mono">${escapeHtml(r.invoice_no || '—')}</td>
      <td>${escapeHtml(r.supplier || '—')}</td>
      <td class="td-mono">${escapeHtml(r.paper_lot)}</td>
      <td class="td-mono">${escapeHtml(r.paper_type || '—')}</td>
      <td class="td-mono td-right">${r.width_mm || '—'}</td>
      <td class="td-mono td-right">${formatNumber(r.weight_kg)}</td>
      <td class="td-mono td-right">${formatNumber(r.remaining_weight_kg)}</td>
      <td><span class="status-badge status-${r.status || 'in_stock'}">${escapeHtml(r.status || 'in_stock')}</span></td>
    </tr>
  `).join('');
  
  // Pagination
  const totalPages = Math.ceil(totalCount / state.listPerPage);
  if (totalPages > 1) {
    let pagHTML = `<button ${state.listPage === 1 ? 'disabled' : ''} data-page="prev">← ก่อน</button>`;
    pagHTML += `<span style="padding: 6px 12px;">หน้า <strong>${state.listPage}</strong> / ${totalPages} (รวม ${totalCount.toLocaleString()} รายการ)</span>`;
    pagHTML += `<button ${state.listPage >= totalPages ? 'disabled' : ''} data-page="next">ถัดไป →</button>`;
    $('#l-pagination').innerHTML = pagHTML;
    
    $$('#l-pagination button').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.page === 'prev' && state.listPage > 1) state.listPage--;
        if (btn.dataset.page === 'next' && state.listPage < totalPages) state.listPage++;
        loadList();
      });
    });
  } else {
    $('#l-pagination').innerHTML = `<span style="color:var(--text-dim); padding: 6px;">รวม ${totalCount.toLocaleString()} รายการ</span>`;
  }
}

function setupListFilters() {
  let searchTimer;
  $('#l-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.listPage = 1;
      loadList();
    }, 400);
  });
  $('#l-filter-supplier').addEventListener('change', () => {
    state.listPage = 1;
    loadList();
  });
  $('#l-filter-status').addEventListener('change', () => {
    state.listPage = 1;
    loadList();
  });
  $('#l-refresh').addEventListener('click', loadList);
}

// ============================================================
// Init
// ============================================================
async function init() {
  setupTabs();
  setupUpload();
  setupListFilters();
  
  await loadMasterData();
  
  setupManual();  // call after master data loaded (need paperTypes)
}

window.addEventListener('DOMContentLoaded', init);
