exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
 
  try {
    const body = JSON.parse(event.body);
    const { pdfBase64 } = body;
 
    if (!pdfBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No PDF data received' }) };
    }
 
    if (!process.env.ANTHROPIC_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY environment variable not set' }) };
    }
 
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
              },
              {
                type: 'text',
                text: `Extract cabinet codes from this PDF. Output ONLY a plain list — no words, no sentences, no headings, no explanations, no asterisks, no dashes as words.
 
This PDF is either:
A) A Katana label sheet — one label per page, code at bottom with prefix like PMW-, OLOA-, PJMW-. Strip prefix, keep code. Count total pages per code.
B) A joinery plan — read PLAN VIEW pages only (header says "Plan view:"), ignore Elevation pages.
 
Each output line must be: CODE QTY
Example output:
SB100 1
B45D2PT 3
W35S 2
W80S 1
 
EXCLUDE (do not list): DW605, TFK, TFK_, SFP, FP, BEP, TEP, UP, F409, FLUPANEL, and anything with PANEL in the name.
 
IMPORTANT — these ARE valid cabinet codes and must be included if present: UBMWHT, UBMWH, UBO60, UBO90.
 
Output the list now. Nothing else.`
              }
            ]
          }
        ]
      })
    });
 
    const rawText = await response.text();
 
    let data;
    try {
      data = JSON.parse(rawText);
    } catch(e) {
      return { statusCode: 500, body: JSON.stringify({ error: `Invalid JSON from Anthropic: ${rawText.substring(0, 200)}` }) };
    }
 
    if (data.error) {
      return { statusCode: 500, body: JSON.stringify({ error: data.error.message || JSON.stringify(data.error) }) };
    }
 
    let text = data.content?.find(b => b.type === 'text')?.text?.trim();
 
    if (!text) {
      return { statusCode: 500, body: JSON.stringify({ error: 'No text returned from Claude' }) };
    }
 
    // Return raw Claude output for debugging
    const rawClaude = text;
 
    // Hard filter — only keep lines that look like valid cabinet codes
    const excluded = new Set(['DW605','TFK','TFK_','SFP','FP','BEP','TEP','UP','F409','FLUPANEL']);
    const validCodePattern = /^[A-Z][A-Z0-9]+[A-Z0-9_]*$/;
 
    const lines = text.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .filter(l => !l.startsWith('#'))
      .filter(l => !l.startsWith('*'))
      .map(l => {
        // Strip finish prefixes like PMW-, OLOA-, PJMW- etc.
        return l.replace(/^[A-Z]{2,6}-/, '');
      })
      .filter(l => {
        const parts = l.trim().split(/\s+/);
        const code = parts[0].toUpperCase();
        if (!validCodePattern.test(code)) return false;
        if (excluded.has(code)) return false;
        if (code.includes('PANEL')) return false;
        if (code.length < 2) return false;
        return true;
      })
      .map(l => {
        const parts = l.trim().split(/\s+/);
        const code = parts[0].toUpperCase();
        const qty = parts[1] && /^\d+$/.test(parts[1]) ? parseInt(parts[1]) : 1;
        return `${code} ${qty}`;
      });
 
    // Detect if Claude has repeated the entire list (common hallucination)
    // Strategy: count how many lines are exact duplicates
    // If more than half the lines are duplicates, the list was repeated — deduplicate by keeping first occurrence
    // Otherwise sum quantities (genuine multiple cabinets of same code)
    const seen = {};
    let duplicateCount = 0;
    lines.forEach(line => {
      if (seen[line]) duplicateCount++;
      seen[line] = true;
    });
    const listWasRepeated = duplicateCount > lines.length * 0.3;
 
    const codeMap = {};
    lines.forEach(line => {
      const [code, qty] = line.split(' ');
      const q = parseInt(qty);
      if (listWasRepeated) {
        // Keep first occurrence only
        if (!codeMap[code]) codeMap[code] = q;
      } else {
        // Sum quantities (genuine duplicates e.g. 3 labels of same cabinet)
        codeMap[code] = (codeMap[code] || 0) + q;
      }
    });
 
    const finalText = Object.entries(codeMap)
      .map(([code, qty]) => `${code} ${qty}`)
      .join('\n');
 
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes: finalText, debug: rawClaude })
    };
 
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
