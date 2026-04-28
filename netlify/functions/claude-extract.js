const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
 
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
 
  try {
    const body = JSON.parse(event.body);
    const { pdfBase64, mode } = body;
 
    if (!pdfBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No PDF data received' }) };
    }
 
    if (!process.env.ANTHROPIC_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY environment variable not set' }) };
    }
 
    const isBenchtop = mode === 'benchtop';
 
    // Calculate approximate page count from base64 size
    // Each page ~2-4KB, so estimate pages from file size
    const fileSizeKB = (pdfBase64.length * 0.75) / 1024;
    const estimatedPages = Math.ceil(fileSizeKB / 3);
    const MAX_PAGES_PER_CHUNK = 20; // Safe limit per API call
 
    // If small enough, process in one go
    if (estimatedPages <= MAX_PAGES_PER_CHUNK) {
      const result = await extractFromPDF(pdfBase64, isBenchtop);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: result })
      };
    }
 
    // Large PDF — we can't split PDFs without a library in Lambda
    // Instead, send with a note to Claude to process all pages systematically
    const result = await extractFromPDFLarge(pdfBase64, isBenchtop, estimatedPages);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes: result })
    };
 
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
 
async function extractFromPDF(pdfBase64, isBenchtop) {
  const prompt = isBenchtop ? getBenchtopPrompt() : getCabinetPrompt();
 
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: prompt }
        ]
      }]
    })
  });
 
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.content?.find(b => b.type === 'text')?.text?.trim();
  if (!text) throw new Error('No text returned from Claude');
  return isBenchtop ? filterBenchtopOutput(text) : filterCabinetOutput(text);
}
 
async function extractFromPDFLarge(pdfBase64, isBenchtop, estimatedPages) {
  // For large PDFs, use higher max_tokens and explicitly instruct to process ALL pages
  const prompt = isBenchtop
    ? `This is a large PDF with approximately ${estimatedPages} pages. ` + getBenchtopPrompt(true)
    : `This is a large PDF with approximately ${estimatedPages} pages. ` + getCabinetPrompt(true);
 
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: prompt }
        ]
      }]
    })
  });
 
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.content?.find(b => b.type === 'text')?.text?.trim();
  if (!text) throw new Error('No text returned from Claude');
  return isBenchtop ? filterBenchtopOutput(text) : filterCabinetOutput(text);
}
 
function getCabinetPrompt(large = false) {
  return `Extract ALL product codes from this Katana label PDF. ${large ? 'Process EVERY single page — do not skip any.' : ''}
 
This PDF may contain cabinets, benchtops and doors/panels mixed together.
 
For each page output one line: CODE VALUE where:
- Cabinets (prefix PMW-, OLOA-, PJMW- etc): strip prefix, output CODE QTY e.g. SB100 1
- Benchtops M2M (prefix BXPMIR-, BXPDKT-, BXPLAM-, BXPCEN-, has metres on label): keep full code, output CODE LENGTH_IN_METRES e.g. BXPMIR-WARMGREY60 2.42
- Benchtops slab (format COLOUR-DIMENSIONS, has pcs on label): keep full code, output CODE QTY e.g. ALPINE-3050900 2
- Doors/panels (prefix ESC-, EMW-, OCO-, PMW- with door suffix, etc): keep full code, output CODE QTY e.g. PMW-BB 4
 
EXCLUDE: DW605, TFK, TFK_, UP, F409, FLUPANEL.
INCLUDE: UBMWHT, UBMWH, UBO60, UBO90.
 
No explanations. No headings. Just the list.`;
}
 
function getBenchtopPrompt(large = false) {
  return getCabinetPrompt(large);
}
 
function filterCabinetOutput(text) {
  const excluded = new Set(['DW605','TFK','TFK_','SFP','FP','BEP','TEP','UP','F409','FLUPANEL']);
  const validCodePattern = /^[A-Z][A-Z0-9]+[A-Z0-9_]*$/;
 
  const lines = text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('*'))
    .map(l => l.replace(/^[A-Z]{2,6}-/, ''))
    .filter(l => {
      const code = l.split(/\s+/)[0].toUpperCase();
      return validCodePattern.test(code) && !excluded.has(code) && !code.includes('PANEL') && code.length >= 2;
    })
    .map(l => {
      const parts = l.trim().split(/\s+/);
      const code = parts[0].toUpperCase();
      const qty = parts[1] && /^\d+$/.test(parts[1]) ? parseInt(parts[1]) : 1;
      return `${code} ${qty}`;
    });
 
  // Smart dedup
  const seen = {};
  let dupCount = 0;
  lines.forEach(line => { if (seen[line]) dupCount++; seen[line] = true; });
  const repeated = dupCount > lines.length * 0.3;
 
  const codeMap = {};
  lines.forEach(line => {
    const [code, qty] = line.split(' ');
    const q = parseInt(qty);
    if (repeated) { if (!codeMap[code]) codeMap[code] = q; }
    else { codeMap[code] = (codeMap[code] || 0) + q; }
  });
 
  return Object.entries(codeMap).map(([code, qty]) => `${code} ${qty}`).join('\n');
}
 
function filterBenchtopOutput(text) {
  const lines = text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('*'))
    .map(l => {
      const parts = l.split(/\s+/);
      const code = parts[0].toUpperCase();
      const val = parseFloat(parts[1]);
      if (!code || isNaN(val)) return null;
      return `${code} ${val}`;
    })
    .filter(Boolean);
 
  // For benchtops — sum values (M2M lengths or slab quantities)
  const codeMap = {};
  lines.forEach(line => {
    const parts = line.split(' ');
    const code = parts[0];
    const val = parseFloat(parts[1]);
    codeMap[code] = (codeMap[code] || 0) + val;
  });
 
  return Object.entries(codeMap).map(([code, val]) => `${code} ${val}`).join('\n');
}
