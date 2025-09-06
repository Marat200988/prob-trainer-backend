import express from 'express'
import fetch from 'node-fetch'
import cors from 'cors'

const app = express()
app.use(express.json())
app.use(cors({
  origin: process.env.ALLOW_ORIGIN || '*',
}))

// healthcheck
app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

// --- утилиты ---
function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try { return JSON.parse(match[0]) } catch {}
  }
  throw new Error('No valid JSON in response')
}
function getDeepseekKey() {
  // Поддержим оба имени, срежем "Bearer " и пробелы
  const raw = (process.env.DEEPSEEK_KEY || process.env.DEEPSEEK_API_KEY || '').trim()
  return raw.replace(/^Bearer\s+/i, '')
}

app.post('/gen-questions', async (req, res) => {
  try {
    console.log('gen-questions body:', JSON.stringify(req.body))
    const apiKey = getDeepseekKey()

    if (!apiKey) {
      console.error('[deepseek] API key missing')
      return res.status(500).json({ error: 'DeepSeek API key is missing on server' })
    }
    // безопасный лог без утечки секрета
    console.log('[deepseek] keyPresent=true len=', apiKey.length)

    const dsResp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        temperature: 0.4,
        response_format: { type: 'json_object' }, // требуем строго JSON
        messages: [
          {
            role: 'system',
            content:
`Ты — генератор задач по теории вероятностей.
Верни СТРОГО JSON:
{"questions":[{"id":"string","section_id":"string","type":"mcq|numeric|confidence","question":"string","options":["..."]|null,"answer":"string|number|{ \\"option\\": \\"...\\", \\"confidence\\": 0-1 }","explanation":"string","learn_url":"string"}]}`
          },
          {
            role: 'user',
            content: `Сгенерируй ${req.body.n || 3} вопросов из разных разделов.`
          }
        ]
      }),
    })

    const text = await dsResp.text()
    console.log('DeepSeek status =', dsResp.status)
    console.log('DeepSeek raw body =', text.slice(0, 180))

    if (!dsResp.ok) {
      // пробрасываем тело для дебага (без ключей)
      return res.status(502).json({ error: 'DeepSeek error', status: dsResp.status, body: text })
    }

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      console.warn('Parse JSON fail, fallback extract:', e.message)
      parsed = extractJson(text)
    }

    res.json(parsed)
  } catch (err) {
    console.error('gen-questions ERROR', err)
    res.status(500).json({ error: String(err) })
  }
})

const port = process.env.PORT || 3000
app.listen(port, () => {
  console.log('Server listening on port', port)
})
