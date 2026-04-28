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
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
            },
            {
              type: 'text',
              text: `You are reading an Amorini joinery plan from Bunnings Trade / Winner software. Extract only the cabinetry unit codes from the plan and elevation drawings.
 
Cabinet codes follow these patterns:
- Base units: B30, B35, B40, B45, B50, B60, B80, B90, B100, B120, BRR45, BRR50, SB60, SB80 etc.
- Wall/overhead units: W30S, W40S, W45S, W50S, W60S, W80S, W90S, W100S, W1005S, W1205S etc.
- Tall/pantry units: P80Z, PRR45Z, PT60, EPT40 etc.
- Drawer units: B45D2P, B453DP, UBO90 etc.
- Specialised: DW605 (dishwasher cabinet), TFK (tall filler kit) etc.
 
DO NOT include these — they are not cabinet boxes:
- SFP (scribe filler panel)
- FP (filler panel)
- BEP (bench end panel)
- TEP (tall end panel)
- UP (underpanel)
- F409 (fascia)
- TFK (tall filler kit)
- DW605 (dishwasher cavity — not a cabinet)
- Any item described as a panel, fascia, filler, or appliance cavity
 
Count each occurrence of a code across ALL plan and elevation drawings in the document, but count each UNIQUE cabinet only ONCE — if the same cabinet appears in both a plan view and an elevation view, count it as 1, not 2.
 
Return ONLY a plain text list, one item per line, in this exact format:
CODE QTY
 
Example:
W30S 2
W100S 1
B45D2P 1
PRR45Z 1
 
No explanations, no headings, no extra text — just the list.`
            }
          ]
        }]
      })
    });
 
    const rawText = await response.text();
 
    let data;
    try {
      data = JSON.parse(rawText);
    } catch(e) {
      return { statusCode: 500, body: JSON.stringify({ error: `Anthropic returned invalid JSON: ${rawText.substring(0, 200)}` }) };
    }
 
    if (data.error) {
      return { statusCode: 500, body: JSON.stringify({ error: data.error.message || JSON.stringify(data.error) }) };
    }
 
    const text = data.content?.find(b => b.type === 'text')?.text?.trim();
 
    if (!text) {
      return { statusCode: 500, body: JSON.stringify({ error: 'No text returned from Claude' }) };
    }
 
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes: text })
    };
 
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
