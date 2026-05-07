// /api/parse-coa-muda.js
// Vercel Serverless Function — receives PDF, returns parsed COA data
// 
// Setup:
//   - ใส่ ANTHROPIC_API_KEY ใน Vercel Env Vars
//   - Deploy ไฟล์นี้ใน /api/ folder ของ project
// 
// Usage:
//   POST /api/parse-coa-muda
//   Body: { pdf_base64: "..." }
//   Returns: { ok: true, parsed: {...} } or { ok: false, error: "..." }

export const config = {
  runtime: 'edge',
  // max 10s per request — Claude usually returns in 5-8s for PDF parsing
};

const SYSTEM_PROMPT = `คุณคือ AI ที่ช่วยอ่าน Certificate of Analysis (COA) จาก Muda Paper Mills SDN BHD

อ่าน PDF แล้วคืน JSON เท่านั้น (ไม่มีคำอธิบาย ไม่มี markdown fence):

{
  "invoice_no": "26040880",
  "delivery_date": "2026-04-29",
  "picking_list": "F26/03500",
  "product": "CORE BOARD - (A)",
  "substance_spec_gsm": 350,
  "test_results": {
    "substance":  [346, 356],
    "thickness":  [0.53, 0.55],
    "moisture":   [6.4, 7.2],
    "bursting":   [4.0, 4.3],
    "bonding":    [211, 240],
    "cobb":       [163, 284]
  }
}

กฎสำคัญ:
- ค่า range "346 ~ 356" หรือ "346~356" → [346, 356]
- ค่าเดียว "5.0" → [5.0, 5.0]
- ถ้าฟิลด์ไหนไม่มีใน COA → null (ทั้งฟิลด์)
- units ตามต้นฉบับ ไม่ต้องแปลง (เช่น bursting เป็น kg/cm² ก็คงไว้)
- delivery_date format: YYYY-MM-DD เสมอ
- ห้ามเดา — ถ้าอ่านไม่ออก/ไม่ชัด → null

field mapping:
- "SUBSTANCE (gsm)" ใน Test Results → substance
- "THICKNESS (mm)" → thickness  
- "MOISTURE (%)" → moisture
- "BURSTING (kg/cm²)" → bursting
- "BONDING (J/M²)" → bonding
- "COBB (gsm)" → cobb`;

export default async function handler(req) {
  // CORS headers (รับ request จาก paper-in.html)
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResp({ ok: false, error: 'Method not allowed — POST only' }, 405, corsHeaders);
  }

  // Check API key configured
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return jsonResp({ ok: false, error: 'Server config error: ANTHROPIC_API_KEY not set' }, 500, corsHeaders);
  }

  // Parse body
  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResp({ ok: false, error: 'Invalid JSON body' }, 400, corsHeaders);
  }

  const { pdf_base64 } = body;
  if (!pdf_base64 || typeof pdf_base64 !== 'string') {
    return jsonResp({ ok: false, error: 'pdf_base64 (string) required in body' }, 400, corsHeaders);
  }

  // Sanity check: PDF base64 ปกติใหญ่ < 5MB
  // (1MB base64 = ~750KB original; 5MB base64 = ~3.75MB original)
  const sizeMB = pdf_base64.length / (1024 * 1024);
  if (sizeMB > 5) {
    return jsonResp({ ok: false, error: `PDF too large (${sizeMB.toFixed(1)}MB base64) — max 5MB` }, 400, corsHeaders);
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
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 }
            },
            { type: 'text', text: 'อ่าน COA นี้และคืน JSON ตาม schema' }
          ]
        }]
      })
    });
  } catch (err) {
    return jsonResp({ ok: false, error: `Network error calling Claude API: ${err.message}` }, 502, corsHeaders);
  }

  if (!apiResp.ok) {
    const errText = await apiResp.text().catch(() => '');
    return jsonResp({ 
      ok: false, 
      error: `Claude API error (${apiResp.status})`,
      detail: errText.slice(0, 500)  // truncate long error
    }, 502, corsHeaders);
  }

  // Extract text from response
  let claudeData;
  try {
    claudeData = await apiResp.json();
  } catch {
    return jsonResp({ ok: false, error: 'Claude API returned invalid JSON' }, 502, corsHeaders);
  }

  // Find first text block (Claude's response)
  const textBlock = (claudeData.content || []).find(b => b.type === 'text');
  if (!textBlock) {
    return jsonResp({ ok: false, error: 'No text in Claude response' }, 502, corsHeaders);
  }

  // Parse Claude's JSON output
  let parsed;
  try {
    // Strip markdown fences if Claude added them
    const clean = textBlock.text.replace(/```json\s*|```\s*/g, '').trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    return jsonResp({ 
      ok: false, 
      error: 'Could not parse Claude response as JSON',
      raw_response: textBlock.text.slice(0, 500)
    }, 502, corsHeaders);
  }

  // Return parsed data + usage info (for cost monitoring)
  const usage = claudeData.usage || {};
  return jsonResp({
    ok: true,
    parsed,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      // Approximate cost in USD (Sonnet 4.5 pricing as of 2026)
      // input: $3/MTok, output: $15/MTok
      estimated_cost_usd: ((usage.input_tokens || 0) * 3 / 1_000_000 + (usage.output_tokens || 0) * 15 / 1_000_000).toFixed(4)
    }
  }, 200, corsHeaders);
}

function jsonResp(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}
