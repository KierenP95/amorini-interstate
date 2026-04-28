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
              text: `Extract all cabinet codes and their quantities from this job sheet or order document.
 
Return ONLY a plain text list, one item per line, in this exact format:
CODE QTY
 
For example:
W600 2
B900 1
T800 3
 
Rules:
- If no quantity is shown, assume 1
- Include only cabinet/product codes — not page numbers, dates, or other numbers
- Do not include any explanation, headings, or extra text — just the code and quantity list`
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
