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
    console.log('gen-questions body:', JSON.stringify(req.body).slice(0, 500))

    const dsResp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner',   // или "deepseek-chat", если этот не доступен
        messages: [
          { role: 'system', content: 'Generate probability training questions. Answer strictly in JSON {questions:[...]}' },
          { role: 'user', content: `Generate ${req.body.count || 5} probability theory questions covering sections: ${req.body.sections?.map(s=>s.title).join(', ')}` },
        ],
        temperature: 0.7,
      }),
    })

    const text = await dsResp.text()
    console.log('DeepSeek status=', dsResp.status)
    console.log('DeepSeek raw body=', text.slice(0, 500))

    if (!dsResp.ok) {
      return res.status(502).json({ error: 'DeepSeek upstream ' + dsResp.status })
    }

    const data = JSON.parse(text)
    const content = data?.choices?.[0]?.message?.content || '{}'
    let parsed
    try {
      parsed = JSON.parse(content)
    } catch (e) {
      console.error('Parse JSON fail:', e, 'content=', content)
      return res.status(500).json({ error: 'Invalid JSON from DeepSeek' })
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
