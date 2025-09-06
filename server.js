// server.js
import express from 'express'
import fetch from 'node-fetch'
import cors from 'cors'

/* ===== mini-logger ===== */
function log(level, msg, obj) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()}: ${msg}`
  if (obj !== undefined) {
    console.log(line, typeof obj === 'string' ? obj : JSON.stringify(obj))
  } else {
    console.log(line)
  }
}

/* Достаём первый корректный JSON из текста (на случай "болтовни" вокруг) */
function extractJson(str) {
  let depth = 0, start = -1
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '{') { if (depth === 0) start = i; depth++ }
    else if (ch === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        const slice = str.slice(start, i + 1)
        try { return JSON.parse(slice) } catch {}
      }
    }
  }
  throw new Error('JSON not found in content')
}

/* ===== In-memory кэш вопросов для проверки ===== */
const QUESTIONS = new Map() // key: q.id -> value: question

/* Приводим вопрос к ожидаемой фронтом форме */
function normalizeQuestion(q, sectionIdFallback = 'misc') {
  const id = String(q.id ?? cryptoRandomId())
  const type = q.type === 'num' ? 'num' : 'mcq'
  const content_md = q.content_md ?? q.content ?? q.text ?? q.title ?? ''
  let options = Array.isArray(q.options) ? q.options.map(String) : []
  if (type === 'mcq' && options.length === 0) {
    // иногда модели любят складывать варианты в поле answers
    if (Array.isArray(q.answers)) options = q.answers.map(String)
  }
  // ответ может быть буквой, индексом или строкой — сведём к букве A/B/C/D
  let answer = q.answer
  if (typeof answer === 'number') {
    const idx = Math.max(0, Math.min(options.length - 1, answer))
    answer = String.fromCharCode(65 + idx) // 0 -> 'A'
  } else if (typeof answer === 'string') {
    const trimmed = answer.trim()
    if (/^\d+$/.test(trimmed)) {
      const idx = Math.max(0, Math.min(options.length - 1, Number(trimmed)))
      answer = String.fromCharCode(65 + idx)
    } else if (/^[A-Da-d]$/.test(trimmed)) {
      answer = trimmed.toUpperCase()
    } else {
      // если это сам вариант (например "3.5"), попробуем найти его в options
      const idx = options.findIndex(o => o.trim() === trimmed)
      if (idx >= 0) answer = String.fromCharCode(65 + idx)
    }
  }
  const explanation_md =
    q.explanation_md ?? q.explanation ?? q.rationale ?? ''

  return {
    id,
    section_id: String(q.section_id ?? sectionIdFallback),
    title: q.title ?? '',
    type,
    content_md,
    options,
    answer,           // ожидаем 'A' | 'B' | ...
    explanation_md,
  }
}

/* простая генерация id */
function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10)
}

const app = express()
app.use(express.json())
app.use(
  cors({
    origin: process.env.ALLOW_ORIGIN || '*',
  })
)

/* health */
app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

/* ===== Генерация вопросов DeepSeek ===== */
app.post('/gen-questions', async (req, res) => {
  const body = req.body || {}
  log('info', 'gen-questions body:', body)

  const apiKey = process.env.DEEPSEEK_KEY || process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing DEEPSEEK_KEY env var' })
  }

  try {
    const sections = Array.isArray(body.sections) ? body.sections : []
    const count = Number(body.count ?? 6) || 6

    const sys =
      'You are a tutor that outputs STRICT JSON only. No backticks, no commentary.'
    const user = `Generate ${count} short probability practice questions for sections (each question belongs to one section by "section_id"):
${JSON.stringify(sections)}
Return pure JSON:
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

    const raw = await dsResp.text()
    log('info', 'DeepSeek status = ' + dsResp.status)
    log('info', 'DeepSeek raw body (head) =', raw.slice(0, 300))

    if (!dsResp.ok) {
      return res
        .status(502)
        .json({ error: 'DeepSeek error', status: dsResp.status, body: raw })
    }

    const data = JSON.parse(raw)
    const content = data?.choices?.[0]?.message?.content ?? ''
    let parsed
    try {
      parsed = JSON.parse(content)
    } catch {
      parsed = extractJson(content)
    }

    const list = Array.isArray(parsed?.questions) ? parsed.questions : []
    const normalized = list.map((q, i) =>
      normalizeQuestion(q, sections[i % Math.max(1, sections.length)]?.id)
    )

    // кэшируем для /check-answer
    normalized.forEach(q => {
      QUESTIONS.set(q.id, q)
    })
    log('debug', `cached ${normalized.length} questions`)

    res.json({ questions: normalized })
  } catch (err) {
    log('error', 'gen-questions ERROR', String(err))
    res.status(500).json({ error: String(err) })
  }
})

/* ===== Проверка ответа =====
   ожидаем body: { qid: string, type: 'mcq'|'num', answer?: string|number }
   для mcq answer может быть 'A'|'B'|'C'|'D' | индекс | сам вариант
*/
app.post('/check-answer', async (req, res) => {
  try {
    log('info', 'check-answer body:', req.body)
    const { qid, type, answer } = req.body || {}
    const q = QUESTIONS.get(String(qid || ''))
    if (!q) {
      return res.status(404).json({ error: 'question_not_found' })
    }

    let userAns = answer
    if (q.type === 'mcq') {
      if (typeof userAns === 'number') {
        userAns = String.fromCharCode(65 + userAns)
      } else if (typeof userAns === 'string') {
        const t = userAns.trim()
        if (/^\d+$/.test(t)) {
          userAns = String.fromCharCode(65 + Number(t))
        } else if (/^[A-Da-d]$/.test(t)) {
          userAns = t.toUpperCase()
        } else {
          const idx = q.options.findIndex(o => o.trim() === t)
          if (idx >= 0) userAns = String.fromCharCode(65 + idx)
        }
      }
    }

    const correct =
      q.type === 'mcq'
        ? String(userAns).toUpperCase() === String(q.answer).toUpperCase()
        : Number(userAns) === Number(q.answer)

    return res.json({
      correct,
      correctAnswer: q.answer,
      explanation_md: q.explanation_md || '',
      question: { id: q.id, content_md: q.content_md, options: q.options, type: q.type },
    })
  } catch (err) {
    log('error', 'check-answer ERROR', String(err))
    res.status(500).json({ error: String(err) })
  }
})

const port = process.env.PORT || 3000
app.listen(port, () => {
  log('info', `Server listening on port ${port}`)
})
