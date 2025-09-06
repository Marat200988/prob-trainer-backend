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

app.post('/gen-questions', async (req, res) => {
  try {
    console.log('gen-questions body:', JSON.stringify(req.body))

    const dsResp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        messages: [
          { role: 'system', content: 'Generate probability training questions' },
          { role: 'user', content: `Generate ${req.body.n || 3} questions` },
        ],
        temperature: 0.7,
      }),
    })

    const text = await dsResp.text()
    console.log('DeepSeek status=', dsResp.status)
    console.log('DeepSeek raw body=', text.slice(0, 200))

    if (!dsResp.ok) {
      return res.status(502).json({ error: 'DeepSeek error', body: text })
    }

    const data = JSON.parse(text)
    const content = data?.choices?.[0]?.message?.content
    let parsed

    try {
      parsed = JSON.parse(content)
    } catch (e) {
      console.error('Parse JSON fail:', e, 'content=', content)
      return res.status(500).json({ error: 'Invalid JSON from DeepSeek', raw: content })
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
