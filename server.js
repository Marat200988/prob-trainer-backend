import express from 'express'
import fetch from 'node-fetch'
import cors from 'cors'

const app = express()
app.use(express.json())
app.use(cors({
  origin: process.env.ALLOW_ORIGIN || '*',
}))

// healthcheck
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      return JSON.parse(match[0])
    } catch (e) {
      console.error("Still invalid JSON:", e)
    }
  }
  throw new Error("No valid JSON in response")
}

app.post('/gen-questions', async (req, res) => {
  try {
    console.log('gen-questions body:', JSON.stringify(req.body))

    const dsResp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        temperature: 0.4,
        response_format: { type: "json_object" }, // <== ключ
        messages: [
          {
            role: 'system',
            content: `Ты — генератор задач по теории вероятностей.
Верни СТРОГО JSON по схеме:
{
  "questions":[
    {
      "id": "string-uuid",
      "section_id": "string",
      "type": "mcq|numeric|confidence",
      "question": "string",
      "options": ["string", "..."] | null,
      "answer": "string|number|{option:string,confidence:number}",
      "explanation": "string",
      "learn_url": "string"
    }
  ]
}`
          },
          {
            role: 'user',
            content: `Сгенерируй ${req.body.n || 3} вопросов из разных разделов.`
          }
        ]
      })
    })

    const text = await dsResp.text()
    console.log("DeepSeek status=", dsResp.status)
    console.log("DeepSeek raw body=", text.slice(0, 200))

    if (!dsResp.ok) {
      return res.status(502).json({ error: 'DeepSeek fail', body: text })
    }

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      console.warn("Parse JSON fail, fallback extract:", err.message)
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
