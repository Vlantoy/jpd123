// Vercel Serverless Function — Gemini API proxy
// Keys stored in Vercel environment variable GEMINI_KEYS (comma-separated)
// Frontend calls POST /api/gemini — keys never exposed to client

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, sysInstruction } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  const keysRaw = process.env.GEMINI_KEYS || '';
  const keys = keysRaw.split(',').map(k => k.trim()).filter(Boolean);
  if (!keys.length) return res.status(500).json({ error: 'No API keys configured on server' });

  const MODELS = [
    'gemini-2.0-flash-lite',
    'gemini-2.5-flash-lite',
  ];

  const errLog = [];

  for (const model of MODELS) {
    for (const key of keys) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      try {
        const body = {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 512, responseMimeType: 'text/plain' },
        };
        if (sysInstruction) {
          body.systemInstruction = { parts: [{ text: sysInstruction }] };
        }

        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!r.ok) {
          const txt = await r.text();
          errLog.push(`[${model}] HTTP ${r.status}: ${txt.slice(0, 120)}`);
          continue;
        }

        const data = await r.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) { errLog.push(`[${model}] empty response`); continue; }

        return res.status(200).json({ text });
      } catch (err) {
        errLog.push(`[${model}] ${err.message}`);
      }
    }
  }

  return res.status(502).json({ error: 'All Gemini keys/models failed', details: errLog });
}
