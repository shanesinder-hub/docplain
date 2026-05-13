export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, type } = req.body;

  if (!text || text.length < 30) {
    return res.status(400).json({ error: 'Please paste more text from the document.' });
  }

  const prompt = `You are a plain-English document decoder. The user has pasted text from a ${type || 'document'}. Analyze it and respond ONLY with a valid JSON object (no markdown, no backticks, no extra text) with exactly these fields:

{
  "plain": "2-3 sentence plain English explanation of what this document means for the person",
  "actions": ["action 1", "action 2", "action 3"],
  "deadline": "specific deadline if one exists, or null if none",
  "risk": "low" or "medium" or "high",
  "riskReason": "one sentence explaining the risk level"
}

Document text:
${text.slice(0, 3000)}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    const raw = data.content?.[0]?.text || '';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
