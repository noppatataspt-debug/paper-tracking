// /api/parse-coa-material.js
// Vercel Serverless Function — รับ PDF (COA วัตถุดิบ) → คืน JSON ที่ normalize แล้ว
// รองรับหลายฟอร์ม/หลาย supplier ในตัวเดียว:
//   - กาว Permaflex (SV-709A/TP) — appearance, viscosity, solids, pH, film, หลาย batch
//   - กาว Bestak (D-490)        — appearance, solids(°Brix), viscosity, pH, หลาย batch
//   - แคลเซียม Surint Omya (OMYACARB) — brightness, fineness, d50, d98, oil_absorption, moisture
//   - supplier/วัตถุดิบใหม่ในอนาคต: Claude map เข้า canonical key ตามความหมาย ไม่ต้องแก้โค้ด
//
// Setup:
//   - ใส่ ANTHROPIC_API_KEY ใน Vercel Env Vars
//   - วางไฟล์นี้ใน /api/ ของ project paper-tracking
//
// Usage:
//   POST /api/parse-coa-material
//   Body: { pdf_base64: "...", material_type: "glue" | "calcium" }
//   Returns: { ok:true, parsed:{ ...lot fields..., batches:[...] }, usage:{...} }
//
// หมายเหตุ: ไฟล์มักเป็น "สแกน" (ภาพ) + อาจมีลายเซ็น/ตราประทับรับเข้า
//   → ใช้ Node serverless + maxDuration กัน timeout, prompt สั่งข้ามลายมือ/ห้ามเดา

export const config = {
  // Node serverless (ไม่ใช่ edge) — รองรับ vision OCR ของ PDF สแกนที่ใช้เวลานานกว่า
  maxDuration: 60,
};

const MODEL = 'claude-sonnet-4-6'; // (parser กระดาษเดิมใช้ 4-5 — เปลี่ยนได้ตามต้องการ)

// ---- canonical parameter keys ต่อ material_type (ให้ตรงกับ material_specs.parameter) ----
const SCHEMA_GUIDE = `
material_type = "glue" → ใช้ canonical keys เหล่านี้ใน coa_values:
  appearance      (text)    ← "Appearance" / ลักษณะ (ค่าที่อ่านได้ เช่น "Brown Transparent" หรือ "Passed")
  viscosity       (number)  ← "Viscosity (cPs)" / "Viscosity cps" (Brookfield)
  solids_content  (number)  ← "Solids content (%)" หรือ "Solids Content (Degree Brix)"
  ph              (number)  ← "pH" / "pH Value"
  film            (text)    ← "Flim"/"Film" (ถ้าไม่มีในใบ → ไม่ต้องใส่ key นี้)

material_type = "calcium" → ใช้ canonical keys เหล่านี้ใน coa_values:
  brightness      (number)  ← "Brightness Ry"
  fineness_325    (number)  ← "Fineness pass 325 mesh"
  d50             (number)  ← "Particle Size Distribution D50%"
  d98             (number)  ← "Particle Size Distribution D98%"
  oil_absorption  (number)  ← "Oil Absorption"
  moisture        (number)  ← "Moisture Content"

ถ้าเจอ parameter อื่นที่อ่านได้แต่ไม่อยู่ในรายการ → ใส่เพิ่มด้วย snake_case key ตามชื่อจริง
`;

function buildSystemPrompt(materialType) {
  return `คุณคือ AI ที่อ่าน Certificate of Analysis (COA) ของวัตถุดิบ แล้วคืน JSON เท่านั้น
(ห้ามมีคำอธิบาย ห้ามมี markdown fence)

material_type ของไฟล์นี้คือ: "${materialType}"

โครงสร้าง JSON ที่ต้องคืน:
{
  "material_type": "${materialType}",
  "supplier": "ชื่อบริษัทผู้ผลิต/ผู้ขาย (ไม่ใช่ Asia Papertube ซึ่งเป็นผู้รับ)",
  "product": "ชื่อสินค้า/รุ่น เช่น SV-709A, BESTAK D-490, OMYACARB 5-LR",
  "invoice_no": "เลข Invoice ถ้ามี — ถ้าไม่มีให้ใช้เลข BOL/เอกสารอ้างอิง — ไม่มีเลย → null",
  "po_no": "เลข PO ถ้ามี ไม่มี → null",
  "coa_date": "วันที่บนใบ COA รูปแบบ YYYY-MM-DD",
  "packing_kg": "ขนาดบรรจุเป็นกิโลกรัม (number) ถ้ามี ไม่มี → null",
  "conclusion": "ผลสรุป เช่น PASSED ถ้ามี ไม่มี → null",
  "batches": [
    {
      "batch_no": "เลข Batch/Lot ตามที่ปรากฏ (เช่น 26060569, 26 F 08, หรือ Lot Number)",
      "mfg_date": "วันผลิต YYYY-MM-DD ถ้ามี ไม่มี → null",
      "exp_date": "วันหมดอายุ YYYY-MM-DD ถ้ามี ไม่มี → null",
      "quantity_kg": "ปริมาณ kg ของ batch นี้ถ้ามี (number) ไม่มี → null",
      "coa_values": { ...ผลทดสอบของ batch นี้ ตาม canonical key ด้านล่าง... }
    }
  ]
}

${SCHEMA_GUIDE}

กฎสำคัญ:
- 1 ใบ COA อาจมีหลาย batch (คอลัมน์ Batch No. หลายคอลัมน์) → คืนทุก batch เป็นรายการใน "batches"
- ถ้าใบมี Lot Number เดียว (เช่น COA แคลเซียม) → "batches" มี 1 รายการ ใช้ Lot Number เป็น batch_no
- คอลัมน์ที่เป็น "-" หรือว่าง (batch ที่ไม่ได้ใช้) → ข้าม ไม่ต้องสร้าง batch นั้น
- ใน coa_values: ค่าตัวเลขให้เป็น number ล้วน (ตัดคอมมา: "7,120" → 7120 ; "99.9980" → 99.998)
- ค่าที่เป็นข้อความ (appearance/film) เก็บเป็น string ตามที่อ่านได้ (เช่น "Brown Transparent", "Passed")
- เก็บเฉพาะ "ผลทดสอบ (Result)" ของแต่ละ batch — ไม่ต้องเก็บคอลัมน์ Specification
- วันที่: แปลงเป็น YYYY-MM-DD เสมอ (เช่น "16/06/2026" → "2026-06-16", "05-06-26" → "2026-06-05", "06-09-26" → "2026-09-06")
- ไฟล์นี้เป็นสแกน อาจมีลายเซ็น/ลายมือ/ตราประทับรับเข้าของหัวหน้างาน → ไม่ต้องอ่าน/ไม่ต้องใส่ใน JSON
- ห้ามเดา: ถ้าตัวเลข/ข้อความพิมพ์อ่านไม่ชัด → ใส่ null (อย่าใส่ค่าที่ไม่มั่นใจ)`;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed — POST only' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'Server config error: ANTHROPIC_API_KEY not set' });
  }

  // Parse body (Node serverless: req.body อาจเป็น object หรือ string)
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error: 'Invalid JSON body' }); }
  }
  body = body || {};

  const { pdf_base64, material_type } = body;
  if (!pdf_base64 || typeof pdf_base64 !== 'string') {
    return res.status(400).json({ ok: false, error: 'pdf_base64 (string) required in body' });
  }
  const mt = (material_type === 'calcium') ? 'calcium' : 'glue'; // default glue
  if (!material_type) {
    // ไม่ fail แต่เตือน — frontend ควรส่ง material_type มาด้วย
    console.warn('material_type not provided — defaulting to "glue"');
  }

  // Sanity check ขนาด (5MB base64 ≈ 3.75MB จริง) — สแกนปกติ < 1MB
  const sizeMB = pdf_base64.length / (1024 * 1024);
  if (sizeMB > 8) {
    return res.status(400).json({ ok: false, error: `PDF too large (${sizeMB.toFixed(1)}MB base64) — max 8MB` });
  }

  // Call Claude API
  let apiResp;
  try {
    apiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system: buildSystemPrompt(mt),
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } },
            { type: 'text', text: 'อ่าน COA นี้และคืน JSON ตาม schema (วัตถุดิบ = ' + mt + ')' }
          ]
        }]
      })
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: `Network error calling Claude API: ${err.message}` });
  }

  if (!apiResp.ok) {
    const errText = await apiResp.text().catch(() => '');
    return res.status(502).json({ ok: false, error: `Claude API error (${apiResp.status})`, detail: errText.slice(0, 500) });
  }

  let claudeData;
  try { claudeData = await apiResp.json(); }
  catch { return res.status(502).json({ ok: false, error: 'Claude API returned invalid JSON' }); }

  const textBlock = (claudeData.content || []).find(b => b.type === 'text');
  if (!textBlock) return res.status(502).json({ ok: false, error: 'No text in Claude response' });

  let parsed;
  try {
    const clean = textBlock.text.replace(/```json\s*|```\s*/g, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    return res.status(502).json({ ok: false, error: 'Could not parse Claude response as JSON', raw_response: textBlock.text.slice(0, 500) });
  }

  // ปรับ default + ตรวจขั้นต่ำ
  parsed.material_type = parsed.material_type || mt;
  if (!Array.isArray(parsed.batches)) parsed.batches = [];

  const usage = claudeData.usage || {};
  return res.status(200).json({
    ok: true,
    parsed,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      // Sonnet pricing ~ $3/MTok in, $15/MTok out (สแกน = input สูงกว่าหน่อยเพราะเป็นภาพ)
      estimated_cost_usd: ((usage.input_tokens || 0) * 3 / 1e6 + (usage.output_tokens || 0) * 15 / 1e6).toFixed(4)
    }
  });
}
