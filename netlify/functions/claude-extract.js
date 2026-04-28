exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
 
  try {
    const body = JSON.parse(event.body);
    const { pdfBase64, startPage, endPage, totalPages } = body;
 
    if (!pdfBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No PDF data received' }) };
    }
 
    if (!process.env.ANTHROPIC_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY environment variable not set' }) };
    }
 
    const isChunked = startPage && endPage && totalPages && totalPages > 50;
 
    const pageInstruction = isChunked
      ? `This PDF has ${totalPages} pages total. Focus ONLY on pages ${startPage} to ${endPage}. Extract codes from those pages only.`
      : '';
 
    const prompt = `Extract ALL product codes from this Katana label PDF. Process every single page.${pageInstruction ? '\n\n' + pageInstruction : ''}
 
This PDF may contain cabinets, benchtops and doors/panels mixed together.
 
For each page output one line: CODE VALUE where:
- Cabinets (prefix PMW-, OLOA-, PJMW- etc): strip prefix, output CODE QTY e.g. SB100 1
- Benchtops M2M (prefix BXP-, has metres on label): keep full code, output CODE LENGTH e.g. BXPMIR-WARMGREY60 2.42
- Benchtops slab (format COLOUR-DIMENSIONS, has pcs): keep full code, output CODE QTY e.g. ALPINE-3050900 2
- Doors/panels (all other codes): keep full code, output CODE QTY e.g. PMW-BB 4
 
EXCLUDE: DW605, TFK, TFK_, UP, F409, FLUPANEL.
INCLUDE: UBMWHT, UBMWH, UBO60, UBO90.
 
No explanations. No headings. Just the list.`;
 
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
            { type: 'text', text: prompt }
          ]
        }]
      })
    });
 
    const rawText = await response.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch(e) { return { statusCode: 500, body: JSON.stringify({ error: `Invalid JSON: ${rawText.substring(0, 300)}` }) }; }
 
    if (data.error) {
      return { statusCode: 500, body: JSON.stringify({ error: data.error.message || JSON.stringify(data.error) }) };
    }
 
    let text = data.content?.find(b => b.type === 'text')?.text?.trim();
    if (!text) return { statusCode: 500, body: JSON.stringify({ error: 'No text returned from Claude' }) };
 
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
        return `${code} ${val}`;
      })
      .filter(Boolean);
 
    // Smart dedup
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
 
    const finalText = Object.entries(codeMap).map(([code, val]) => `${code} ${val}`).join('\n');
 
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes: finalText })
    };
 
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
