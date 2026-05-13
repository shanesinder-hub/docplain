exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const { text, type } = JSON.parse(event.body);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'You are a plain-English document decoder. The user pasted text from a ' + (type || 'document') + '. Respond ONLY with valid JSON, no markdown:\n{"plain":"2-3 sentence explanation","actions":["action 1","action 2","action 3"],"risk":"low","riskReason":"one sentence"}\n\nDocument:\n' + text.slice(0, 3000) }]
    })
  });

  const data = await response.json();
  const raw = data.content[0].text.replace(/```json|```/g, '').trim();

  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: raw
  };
};
