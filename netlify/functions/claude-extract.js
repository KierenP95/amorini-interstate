const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
 
// Install pdf-lib if not available
let PDFLib;
try {
  PDFLib = require('pdf-lib');
} catch(e) {
  // Will handle below
}
 
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
 
    // Estimate page count from file size
    const fileSizeKB = (pdfBase64.length * 0.75) / 1024;
    const estimatedPages = Math.ceil(fileSizeKB / 3);
    const CHUNK_SIZE = 30; // pages per chunk
 
    if (estimatedPages <= CHUNK_SIZE) {
      // Small PDF — process directly
      const result = await callClaude(pdfBase64);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: processOutput(result) })
      };
    }
 
    // Large PDF — split into chunks using pdf-lib
    const pdfBytes = Buffer.from(pdfBase64, 'base64');
    
    try {
      if (!PDFLib) PDFLib = require('/var/task/node_modules/pdf-lib');
      
      const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes);
      const totalPages = pdfDoc.getPageCount();
      
      const allResults = [];
      
      for (let start = 0; start < totalPages; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE, totalPages);
        
        // Create a sub-document with this chunk of pages
        const subDoc = await PDFLib.PDFDocument.create();
        const pageIndices = [];
        for (let i = start; i < end; i++) pageIndices.push(i);
        
        const copiedPages = await subDoc.copyPagesFrom(pdfDoc, pageIndices);
        copiedPages.forEach(page => subDoc.addPage(page));
        
        const subPdfBytes = await subDoc.save();
        const subBase64 = Buffer.from(subPdfBytes).toString('base64');
        
        const chunkResult = await callClaude(subBase64);
        allResults.push(chunkResult);
      }
      
      // Merge all chunk results
      const merged = mergeResults(allResults);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: merged })
      };
      
    } catch(splitErr) {
      // pdf-lib not available — fall back to sending full PDF with higher token limit
      const result = await callClaudeLarge(pdfBase64, estimatedPages);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: processOutput(result) })
      };
    }
 
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
 
async function callClaude(pdfBase64) {
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
          { type: 'text', text: getPrompt() }
        ]
      }]
    })
  });
 
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.content?.find(b => b.type === 'text')?.text?.trim() || '';
}
 
async function callClaudeLarge(pdfBase64, estimatedPages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: `This PDF has approximately ${estimatedPages} pages. Process ALL pages without skipping any.\n\n` + getPrompt() }
        ]
      }]
    })
  });
 
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.content?.find(b => b.type === 'text')?.text?.trim() || '';
}
 
function getPrompt() {
  return `Extract ALL product codes from this Katana label PDF. Process every single page.
 
This PDF may contain cabinets, benchtops and doors/panels mixed together.
 
For each page output one line: CODE VALUE where:
- Cabinets (prefix PMW-, OLOA-, PJMW- etc): strip prefix, output CODE QTY e.g. SB100 1
- Benchtops M2M (prefix BXP-, has metres on label): keep full code, output CODE LENGTH e.g. BXPMIR-WARMGREY60 2.42
- Benchtops slab (format COLOUR-DIMENSIONS, has pcs): keep full code, output CODE QTY e.g. ALPINE-3050900 2
- Doors/panels (all other codes): keep full code, output CODE QTY e.g. PMW-BB 4
 
EXCLUDE: DW605, TFK, TFK_, UP, F409, FLUPANEL.
INCLUDE: UBMWHT, UBMWH, UBO60, UBO90.
 
No explanations. No headings. Just the list.`;
}
 
function processOutput(text) {
  const excluded = new Set(['DW605','TFK','TFK_','UP','F409','FLUPANEL']);
 
  const lines = text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('*'))
    .map(l => {
      const parts = l.split(/\s+/);
      const code = parts[0].toUpperCase();
      const val = parseFloat(parts[1]);
      if (!code || !code.match(/^[A-Z][A-Z0-9\-]+$/) || isNaN(val)) return null;
      if (excluded.has(code)) return null;
      if (code.includes('PANEL') && !code.includes('BEP') && !code.includes('TEP')) return null;
      return `${code} ${val}`;
    })
    .filter(Boolean);
 
  // Smart dedup — detect if list was repeated
  const seen = {};
  let dupCount = 0;
  lines.forEach(line => { if (seen[line]) dupCount++; seen[line] = true; });
  const repeated = dupCount > lines.length * 0.3;
 
  const codeMap = {};
  lines.forEach(line => {
    const parts = line.split(' ');
    const code = parts[0];
    const val = parseFloat(parts[1]);
    if (repeated) { if (!codeMap[code]) codeMap[code] = val; }
    else { codeMap[code] = (codeMap[code] || 0) + val; }
  });
 
  return Object.entries(codeMap).map(([code, val]) => `${code} ${val}`).join('\n');
}
 
function mergeResults(results) {
  const codeMap = {};
  results.forEach(result => {
    const processed = processOutput(result);
    processed.split('\n').filter(Boolean).forEach(line => {
      const parts = line.split(' ');
      const code = parts[0];
      const val = parseFloat(parts[1]);
      codeMap[code] = (codeMap[code] || 0) + val;
    });
  });
  return Object.entries(codeMap).map(([code, val]) => `${code} ${val}`).join('\n');
}
