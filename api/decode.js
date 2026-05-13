export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const { text, type } = req.body;
  if (!text || text.length < 30) return res.status(400).json({ error: 'Please paste more text.' });

  const prompt = `You are a plain-English document decoder. The user has pasted text from a ${type || 'document'}. Respond ONLY with valid JSON, no markdown, no backticks:

{"plain":"2-3 sentence explanation","actions":["action 1","action 2","action 3"],"deadline":"specific deadline or null","risk":"low or medium or high","riskReason":"one sentence"}

Document text: ${text.slice(0, 3000)}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: JSON.stringify(data) });
    
    const raw = data.content?.[0]?.text || '';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
}
