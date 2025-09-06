// server.js
import express from 'express'
import fetch from 'node-fetch'
import cors from 'cors'

/**
 * Быстрый логгер с метками
 */
function log(level, msg, obj) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()}: ${msg}`
  if (obj !== undefined) {
    console.log(line, typeof obj === 'string' ? obj : JSON.stringify(obj))
  } else {
    console.log(line)
  }
}

/**
 * Достаёт первый корректный JSON из строки (если вокруг есть текст).
 */
function extractJson(str) {
  let depth = 0
  let start = -1
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        const candidate = str.slice(start, i + 1)
        try {
          return JSON.parse(candidate)
        } catch {
          // продолжаем искать следующий блок
        }
      }
    }
  }
  throw new Error('JSON not found in content')
}

const app = express()
app.use(express.json())

app.use(
  cors({
    origin: process.env.ALLOW_ORIGIN || '*',
  })
)

// --- healthcheck ---
app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

/**
 * Генерация вопросов через DeepSeek
 * body: { sections: [{id,title}...], count: number }
 */
app.post('/gen-questions', async (req, res) => {
  const body = req.body || {}
  log('info', 'gen-questions body:', body)

  const apiKey = process.env.DEEPSEEK_KEY || process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing DEEPSEEK_KEY env var' })
  }

  try {
    // Формируем минимальный промпт
    const sys = 'You are a tutor that outputs STRICT JSON only.'
    const user = `Generate ${body.count || 6} short probability questions for sections: ${JSON.stringify(
      body.sections || []
    )}.
Return pure JSON of the shape:
{"questions":[{"id":"string","section_id":"string","title":"string","type":"mcq|num","content_md":"string","options":["A","B","C","D"],"answer":"A","explanation_md":"string"}]}`

    const dsResp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        temperature: 0.7,
      }),
    })

    const text = await dsResp.text()
    log('info', 'DeepSeek status = ' + dsResp.status)
    log('info', 'DeepSeek raw body (head) =', text.slice(0, 300))

    if (!dsResp.ok) {
      return res
        .status(502)
        .json({ error: 'DeepSeek error', status: dsResp.status, body: text })
    }

    // общий объект ответа
    const data = JSON.parse(text)

    // контент с ответом модели
    const content = data?.choices?.[0]?.message?.content ?? ''
    log('debug', 'DeepSeek content (head) = ' + content.slice(0, 200))

    let parsed
    try {
      parsed = JSON.parse(content) // если пришёл «чистый» JSON
    } catch {
      parsed = extractJson(content) // вырезаем JSON из текста
    }

    // простая валидация
    const n = Array.isArray(parsed?.questions) ? parsed.questions.length : 0
    log('debug', 'parsed.questions count = ' + n)

    return res.json(parsed)
  } catch (err) {
    log('error', 'gen-questions ERROR', String(err))
    return res.status(500).json({ error: String(err) })
  }
})

const port = process.env.PORT || 3000
app.listen(port, () => {
  log('info', `Server listening on port ${port}`)
})
