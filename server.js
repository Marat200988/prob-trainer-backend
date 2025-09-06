// server.js
import express from 'express'
import fetch from 'node-fetch'
import cors from 'cors'

/* ===== logger ===== */
function log(level, msg, obj) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()}: ${msg}`
  if (obj !== undefined) {
    console.log(line, typeof obj === 'string' ? obj : JSON.stringify(obj))
  } else {
    console.log(line)
  }
}

/* Вытаскиваем первый валидный JSON даже если модель «болтает» вокруг */
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

/* ===== кэш вопросов для проверки ===== */
const QUESTIONS = new Map() // id -> question

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10)
}

/* Приведение вопроса к форме фронта */
function normalizeQuestion(q, sectionIdFallback = 'misc') {
  const id = String(q.id ?? cryptoRandomId())
  const type = q.type === 'num' ? 'num' : 'mcq'
  const content_md = q.content_md ?? q.content ?? q.text ?? q.title ?? ''
  let options = Array.isArray(q.options) ? q.options.map(String) : []
  if (type === 'mcq' && options.length === 0 && Array.isArray(q.answers)) {
    options = q.answers.map(String)
  }

  // нормализуем «правильный ответ»
  let answer = q.answer
  if (typeof answer === 'number') {
    const idx = Math.max(0, Math.min(options.length - 1, answer))
    answer = String.fromCharCode(65 + idx)
  } else if (typeof answer === 'string') {
    const t = answer.trim()
    if (/^\d+$/.test(t)) {
      const idx = Math.max(0, Math.min(options.length - 1, Number(t)))
      answer = String.fromCharCode(65 + idx)
    } else if (/^[A-Da-d]$/.test(t)) {
      answer = t.toUpperCase()
    } else {
      const idx = options.findIndex(o => o.trim() === t)
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
    answer,
    explanation_md,
  }
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

/* ===== генерация вопросов ===== */
app.post('/gen-questions', async (req, res) => {
  const body = req.body || {}
  log('info', 'gen-questions body:', body)

  const apiKey = process.env.DEEPSEEK_KEY || process.env.DEEPSEEK_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'Missing DEEPSEEK_KEY' })

  try {
    const sections = Array.isArray(body.sections) ? body.sections : []
    const count = Number(body.count ?? 6) || 6

    const systemMsg =
      'Ты преподаватель по вероятности. Отвечай ТОЛЬКО валидным JSON, без комментариев и бэктиков.'
    const userMsg = `Сгенерируй ${count} коротких тренировочных задач по вероятности для разделов (каждая задача имеет поле "section_id" из списка ниже).
Все тексты и варианты — на русском. Верни чистый JSON ровно такого вида:
{
  "questions": [{
    "id":"строка",
    "section_id":"строка",
    "title":"строка",
    "type":"mcq|num",
    "content_md":"строка",
    "options":["A","B","C","D"],
    "answer":"A",
    "explanation_md":"строка"
  }]
}
Разделы: ${JSON.stringify(sections)}
`

    const dsResp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: userMsg },
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
    try { parsed = JSON.parse(content) } catch { parsed = extractJson(content) }

    const list = Array.isArray(parsed?.questions) ? parsed.questions : []
    const normalized = list.map((q, i) =>
      normalizeQuestion(q, sections[i % Math.max(1, sections.length)]?.id)
    )

    normalized.forEach(q => QUESTIONS.set(q.id, q))
    log('debug', `cached ${normalized.length} questions`)

    res.json({ questions: normalized })
  } catch (err) {
    log('error', 'gen-questions ERROR', String(err))
    res.status(500).json({ error: String(err) })
  }
})

/* ===== проверка ответа ===== */
app.post('/check-answer', async (req, res) => {
  try {
    log('info', 'check-answer body:', req.body)

    // Поддерживаем обе формы:
    // 1) { qid, type, answer }
    // 2) { question:{id,...,type,...}, userAnswer }
    const qid =
      String(
        req.body?.qid ??
          req.body?.question?.id ??
          req.body?.id ??
          ''
      )
    let userAns =
      req.body?.answer ??
      req.body?.userAnswer ??
      req.body?.value
    const type =
      req.body?.type ??
      req.body?.question?.type ??
      (QUESTIONS.get(qid)?.type ?? 'mcq')

    const q = QUESTIONS.get(qid)
    if (!q) {
      log('warn', 'question_not_found for qid=' + qid)
      return res.status(404).json({ error: 'question_not_found' })
    }

    // Нормализуем ответ пользователя
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

    const payload = {
      correct,
      correctAnswer: q.answer,
      explanation_md: q.explanation_md || '',
      question: { id: q.id, type: q.type, content_md: q.content_md, options: q.options },
    }
    log('debug', 'check-answer result:', payload)
    return res.json(payload)
  } catch (err) {
    log('error', 'check-answer ERROR', String(err))
    res.status(500).json({ error: String(err) })
  }
})

const port = process.env.PORT || 3000
app.listen(port, () => {
  log('info', `Server listening on port ${port}`)
})
