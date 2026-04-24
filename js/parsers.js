/* ============================================================
   Paper-In Parsers
   ============================================================
   Parser สำหรับแต่ละ Supplier:
   - SCG    : TXT format (fixed-width) + XLSX COA
   - MPK    : CSV Packing List
   - United : XLSX (ยูไนเต็ดฯ)
   - Muda   : XLS Packing List + PDF COA (ไฟล์ซับซ้อน)
   
   ทุก parser return format เดียวกัน:
   {
     supplier: 'SCG',
     invoice_no: '0535197728',
     invoice_date: '2026-04-23',
     po_no: 'Po-690295',
     rolls: [
       { paper_lot, paper_lot_normalized, paper_type, 
         width_mm, weight_kg, coa: {...} }
     ]
   }
   ============================================================ */

// Utility: normalize lot (ตัด - ออก และเป็น uppercase)
export function normalizeLot(lot) {
  return String(lot || '').replace(/-/g, '').toUpperCase().trim();
}

// Utility: parse date จากหลายรูปแบบ
export function parseDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  
  // DD/MM/YYYY
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  
  // Excel serial number (e.g. 46094)
  if (/^\d{5}$/.test(s)) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + parseInt(s) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  
  return null;
}

// Utility: parse number (ตัด , ออก)
export function parseNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

// ============================================================
// SCG TXT Parser
// ============================================================
// format fixed-width 108 chars:
// [0:10]   paper_lot        (776A19031G)
// [10:16]  paper_type       (CPS450)
// [16:19]  width_cm         (161)
// [19:24]  weight_kg        (01261 = 1261 kg, มี leading 0)
// [24:30]  unknown
// [30:40]  dp_number/invoice(0535197728)
// [40:50]  invoice_date     (23/04/2026)
// [50:51]  flag
// [51:60]  po_no            (Po-690295)
// (ที่เหลือเป็น metadata เพิ่มเติม)
// ============================================================
export function parseSCG_TXT(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length >= 100);
  if (!lines.length) throw new Error('ไม่พบข้อมูลใน SCG TXT');

  const rolls = [];
  let invoice_no = null;
  let invoice_date = null;
  let po_no = null;

  for (const line of lines) {
    const lot = line.slice(0, 10).trim();
    const type = line.slice(10, 16).trim();
    const width = parseInt(line.slice(16, 19));
    const weight = parseInt(line.slice(19, 24));
    const dp = line.slice(30, 40).trim();
    const date = line.slice(40, 50).trim();
    const po = line.slice(51, 60).trim();

    if (!lot || !type || isNaN(weight)) continue;

    // เก็บ invoice_no จาก line แรก
    if (!invoice_no) invoice_no = dp;
    if (!invoice_date) invoice_date = parseDate(date);
    if (!po_no) po_no = po;

    rolls.push({
      paper_lot: lot,
      paper_lot_normalized: normalizeLot(lot),
      paper_type: type,
      width_mm: width * 10,  // cm → mm
      weight_kg: weight,
    });
  }

  return {
    supplier: 'SCG',
    invoice_no,
    invoice_date,
    po_no,
    rolls,
  };
}

// ============================================================
// SCG COA XLSX Parser
// ใช้เสริมกับ SCG TXT - เพิ่มข้อมูลคุณภาพให้แต่ละม้วน
// ============================================================
export function parseSCG_COA(rows) {
  // rows = array ของ array (ผล SheetJS)
  // หา header row (มีคำว่า "Batch Number")
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    if (row.some(c => String(c || '').includes('Batch Number'))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const coaList = [];
  for (let i = headerIdx + 2; i < rows.length; i++) {
    const row = rows[i] || [];
    const lot = String(row[0] || '').trim();
    if (!lot || lot.startsWith('AVG')) continue;

    coaList.push({
      paper_lot: lot,
      paper_lot_normalized: normalizeLot(lot),
      coa: {
        production_date: parseDate(row[1]),
        width_cm: parseNum(row[2]),
        basis_weight: parseNum(row[3]),
        burst: parseNum(row[4]),
        plybond: parseNum(row[5]),
        cobb_top: parseNum(row[6]),
        cobb_bottom: parseNum(row[7]),
        caliper: parseNum(row[8]),
        moisture: parseNum(row[9]),
      }
    });
  }
  return coaList;
}

// ============================================================
// MPK CSV Parser
// Packing List format:
// row 13: Date
// row 14: Packing List Number
// row 15: PO + Invoice Number
// row 17: headers (Invoice, Paper_Lot, Type, Width (cm.), Wight (kg.))
// row 18+: data rows
// ============================================================
export function parseMPK_CSV(text) {
  // parse CSV lines
  const lines = text.split(/\r?\n/);
  const rows = lines.map(line => {
    // simple CSV parse (handle quoted fields)
    const result = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQuote = !inQuote; }
      else if (c === ',' && !inQuote) { result.push(cur); cur = ''; }
      else cur += c;
    }
    result.push(cur);
    return result;
  });

  // extract metadata
  let invoice_date = null, po_no = null, invoice_no = null;
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const cell = String(row[i] || '').trim();
      if (cell === 'Date' && row[i+2]) invoice_date = parseDate(row[i+2]);
      if (cell === 'Referred to P.O. or  L/C Number' && row[i+2]) po_no = String(row[i+2]).trim();
      if (cell === 'As of Invoice Number' && row[i+2]) invoice_no = String(row[i+2]).trim();
    }
  }

  // หา header row ที่มี "Paper_Lot"
  let headerIdx = -1, headerCols = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const lotIdx = row.findIndex(c => String(c || '').trim() === 'Paper_Lot');
    if (lotIdx !== -1) {
      headerIdx = i;
      headerCols = {
        invoice: row.findIndex(c => String(c || '').trim() === 'Invoice'),
        lot: lotIdx,
        type: row.findIndex(c => String(c || '').trim() === 'Type'),
        width: row.findIndex(c => String(c || '').trim().startsWith('Width')),
        weight: row.findIndex(c => /W[ie]ight/.test(String(c || '').trim())),
      };
      break;
    }
  }

  if (headerIdx === -1) throw new Error('ไม่พบ header "Paper_Lot" ในไฟล์ MPK');

  const rolls = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const lot = String(row[headerCols.lot] || '').trim();
    if (!lot || lot === 'Total' || lot.startsWith('Remarks')) continue;
    if (!/^[A-Z0-9]+$/i.test(lot)) continue;  // skip non-lot rows

    const weight = parseNum(row[headerCols.weight]);
    if (!weight) continue;

    rolls.push({
      paper_lot: lot,
      paper_lot_normalized: normalizeLot(lot),
      paper_type: String(row[headerCols.type] || '').trim(),
      width_mm: parseNum(row[headerCols.width]) * 10,  // cm → mm
      weight_kg: weight,
    });
  }

  return {
    supplier: 'MPK',
    invoice_no,
    invoice_date,
    po_no,
    rolls,
  };
}

// ============================================================
// United XLSX Parser
// Columns: senddate, sendno, maker, car_no, type, width (inch),
//          width (mm), diameter, productdate, refrollno, kgs, po
// ============================================================
export function parseUnited_XLSX(rows) {
  if (!rows || rows.length < 2) throw new Error('ไฟล์ United ไม่มีข้อมูล');

  // หา header row
  const headers = rows[0].map(c => String(c || '').trim().toLowerCase());
  const col = {
    senddate: headers.indexOf('senddate'),
    sendno: headers.indexOf('sendno'),
    type: headers.indexOf('type'),
    width_mm: headers.findIndex(c => c === 'width (mm)' || c === 'width(mm)'),
    refrollno: headers.indexOf('refrollno'),
    kgs: headers.indexOf('kgs'),
    po: headers.indexOf('po'),
  };

  if (col.refrollno === -1 || col.kgs === -1) {
    throw new Error('ไม่พบ column refrollno หรือ kgs ในไฟล์ United');
  }

  const rolls = [];
  let invoice_no = null, invoice_date = null, po_no = null;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[col.refrollno]) continue;

    const lot = String(row[col.refrollno]).trim();
    const weight = parseNum(row[col.kgs]);
    if (!lot || !weight) continue;

    if (!invoice_no && col.sendno !== -1) invoice_no = String(row[col.sendno]).trim();
    if (!invoice_date && col.senddate !== -1) invoice_date = parseDate(row[col.senddate]);
    if (!po_no && col.po !== -1) po_no = String(row[col.po]).trim();

    rolls.push({
      paper_lot: lot,
      paper_lot_normalized: normalizeLot(lot),
      paper_type: String(row[col.type] || '').trim(),
      width_mm: parseNum(row[col.width_mm]),
      weight_kg: weight,
    });
  }

  return {
    supplier: 'UTP',
    invoice_no,
    invoice_date,
    po_no,
    rolls,
  };
}

// ============================================================
// Muda XLS Parser (Packing List)
// ไฟล์ซับซ้อน - มี header หลายบรรทัด, data กระจายในหลาย column
// ใช้ strategy: หา row ที่มี serial + kgs pattern
// ============================================================
export function parseMuda_XLS(rows) {
  if (!rows || rows.length < 10) throw new Error('ไฟล์ Muda ไม่สมบูรณ์');

  // ดึง metadata
  let invoice_no = null, invoice_date = null, po_no = null;
  let product = null, width_mm = null, gsm = null;

  for (const row of rows) {
    if (!row) continue;
    for (let i = 0; i < row.length; i++) {
      const cell = String(row[i] || '').trim();
      if (cell === 'Invoice No :' && !invoice_no) {
        for (let j = i+1; j < row.length; j++) {
          const v = String(row[j] || '').trim();
          if (v && v !== 'SSI') { invoice_no = 'SSI ' + v.replace(/\.0$/,''); break; }
        }
      }
      if (cell.startsWith('Date') && !invoice_date) {
        for (let j = i+1; j < row.length; j++) {
          const v = row[j];
          if (v) { invoice_date = parseDate(v); if (invoice_date) break; }
        }
      }
      if (cell.includes('Purchase Order No') && !po_no) {
        const m = cell.match(/PO-(\d+)/);
        if (m) po_no = 'PO-' + m[1];
      }
      if (cell === 'CORE BOARD - E' || cell.includes('CORE BOARD')) product = 'CORE BOARD - E';
      if (cell === 'Width :' || cell.startsWith('Width :')) {
        const mm = row.slice(i).join(' ').match(/(\d+)\s*mm/);
        if (mm) width_mm = parseInt(mm[1]);
      }
      if (/^\d{3}$/.test(cell) && i > 0 && String(row[i-1]||'').includes('gsm') === false) {
        const nextCell = String(row[i+1] || '').trim();
        if (nextCell === 'gsm') gsm = parseInt(cell);
      }
    }
  }

  // หา rolls - rows ที่มี serial number pattern (e.g. 42860403214G, 1055.0)
  const rolls = [];
  const serialPattern = /^\d{10,12}[A-Z]?$/;

  for (const row of rows) {
    if (!row) continue;
    // Muda format: มี 2 ม้วน/row (2 columns of serial + kgs)
    for (let i = 0; i < row.length - 1; i++) {
      const cell = String(row[i] || '').trim();
      if (!serialPattern.test(cell)) continue;

      // หาค่า kgs ถัดไป (อาจอยู่ 3-5 column ถัดไป)
      let weight = null;
      for (let j = i+1; j < Math.min(i+8, row.length); j++) {
        const v = parseNum(row[j]);
        if (v && v > 500 && v < 3000) { weight = v; break; }
      }

      if (weight) {
        // กำหนด paper_type จาก product + gsm ที่เจอ
        let paper_type = 'CBE-450';  // default สำหรับ CORE BOARD - E 450gsm
        if (gsm === 450 && product && product.includes('CORE BOARD - E')) paper_type = 'CBE-450';
        else if (gsm === 350) paper_type = 'CBE-350';
        else if (gsm === 600) paper_type = 'CBE-600';

        rolls.push({
          paper_lot: cell,
          paper_lot_normalized: normalizeLot(cell),
          paper_type,
          width_mm,
          weight_kg: weight,
        });
      }
    }
  }

  return {
    supplier: 'Muda',
    invoice_no,
    invoice_date,
    po_no,
    rolls,
  };
}

// ============================================================
// Detect file type & dispatch to parser
// ============================================================
export function detectSupplier(filename, content) {
  const n = filename.toLowerCase();
  
  // SCG - TXT ที่ชื่อขึ้นต้นด้วย 05351977xx
  if (n.endsWith('.txt') && /05\d{8}/.test(n)) return 'SCG_TXT';
  
  // SCG COA - XLSX ที่มี "COA" ในชื่อและเริ่มด้วย 05351977xx
  if (n.includes('coa') && /05\d{8}/.test(n)) return 'SCG_COA';
  
  // MPK - CSV PACKING_LIST  
  if (n.includes('packing') && n.endsWith('.csv')) return 'MPK_CSV';
  
  // United - XLSX ชื่อ ASPT หรือ UTP
  if (n.startsWith('aspt') || n.startsWith('utp') || n.includes('united')) return 'United_XLSX';
  
  // Muda - XLS ชื่อ Asia_Tube + PL
  if (n.includes('asia_tube') && n.includes('pl_')) return 'Muda_XLS';
  
  // Muda COA
  if (n.includes('asia_tube') && n.includes('coa')) return 'Muda_COA';
  
  return null;
}
