export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { text, type } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  const prompt = 'You are a plain-English document decoder. The user pasted text from a ' + (type || 'document') + '. Respond ONLY with valid JSON, no markdown:\n{"plain":"2-3 sentence explanation","actions":["action 1","action 2","action 3"],"risk":"low","riskReason":"one sentence"}\n\nDocument:\n' + text.slice(0, 3000);

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
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  if (!response.ok) return res.status(500).json({ error: data.error?.message || 'API error' });

  const raw = data.content[0].text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(raw);
  res.status(200).json(parsed);
}
