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
 
    const cabinetPrompt = `Extract cabinet codes from this PDF. Output ONLY a plain list — no words, no sentences, no headings, no explanations, no asterisks, no dashes as words.
 
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
 
Output the list now. Nothing else.`;
 
    const benchtopPrompt = `Extract benchtop codes from this Katana label PDF. Output ONLY a plain list — no words, no sentences, no headings, no explanations.
 
Each page has a benchtop code and either:
- A length in metres (e.g. 2.42 m) for made-to-measure benchtops (codes starting with BXP)
- A qty in pcs (e.g. 2 pcs) for slab benchtops
 
For each page output one line: CODE VALUE
- Made-to-measure (has metres on label): CODE LENGTH_IN_METRES  e.g. BXPMIR-WARMGREY60 2.42
- Slab (has pcs on label): CODE QTY  e.g. ALPINE-3050900 2
 
Rules:
- Keep the full code including any prefix like BXPMIR-, BXPDKT-, BXPLAM-, BXPCEN-, DEK-, A-
- Do NOT strip prefixes from benchtop codes
- Each page = one line in the output
- No explanations, no headings, just the list
 
Output the list now. Nothing else.`;
 
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
                text: isBenchtop ? benchtopPrompt : cabinetPrompt
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
 
    const rawClaude = text;
 
    if (isBenchtop) {
      // Benchtop mode — keep codes with numeric values, strip junk lines
      const validBenchtopPattern = /^[A-Z][A-Z0-9\-]+[A-Z0-9]$/;
      const lines = text.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .filter(l => !l.startsWith('#'))
        .filter(l => !l.startsWith('*'))
        .map(l => {
          const parts = l.split(/\s+/);
          const code = parts[0].toUpperCase();
          const val = parseFloat(parts[1]);
          if (!code || isNaN(val)) return null;
          return `${code} ${val}`;
        })
        .filter(Boolean);
 
      // Deduplicate — keep first occurrence
      const seen = {};
      const deduped = lines.filter(line => {
        const code = line.split(' ')[0];
        if (seen[code]) return false;
        seen[code] = true;
        return true;
      });
 
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: deduped.join('\n'), debug: rawClaude })
      };
 
    } else {
      // Cabinet mode — existing logic
      const excluded = new Set(['DW605','TFK','TFK_','SFP','FP','BEP','TEP','UP','F409','FLUPANEL']);
      const validCodePattern = /^[A-Z][A-Z0-9]+[A-Z0-9_]*$/;
 
      const lines = text.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .filter(l => !l.startsWith('#'))
        .filter(l => !l.startsWith('*'))
        .map(l => l.replace(/^[A-Z]{2,6}-/, ''))
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
 
      // Smart dedup
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
          if (!codeMap[code]) codeMap[code] = q;
        } else {
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
    }
 
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
