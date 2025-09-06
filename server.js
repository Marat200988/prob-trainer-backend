import express from 'express'
import cors from 'cors'
import fetch from 'node-fetch'
import { z } from 'zod'

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(cors({ origin: process.env.ALLOW_ORIGIN ? [process.env.ALLOW_ORIGIN] : true }))

const QSchema = z.object({
  id: z.string(),
  section_id: z.string(),
  lesson_id: z.string().optional(),
  type: z.enum(['mcq','numeric','short']),
  prompt: z.string(),
  options: z.array(z.string()).optional(),
  correct_index: z.number().optional(),
  numeric_answer: z.number().nullable().optional(),
  explanation: z.string()
})
const RespSchema = z.object({ questions: z.array(QSchema) })
const CheckSchema = z.object({ correct: z.boolean(), explanation: z.string() })

app.get('/', (req,res)=> res.json({ ok:true }))

app.post('/gen-questions', async (req,res)=>{
  try{
    const { sections = [], count = 6 } = req.body || {}
    if(!process.env.DEEPSEEK_API_KEY) throw new Error('No DEEPSEEK_API_KEY')
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method:'POST',
      headers:{ 'Authorization':`Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        model:'deepseek-chat',
        messages:[
          { role:'system', content:"\nYou generate exam-style probability questions.\nReturn STRICT JSON only:\n\ntype Question = {\n  id: string;\n  section_id: string;\n  lesson_id?: string;\n  type: 'mcq'|'numeric'|'short';\n  prompt: string;\n  options?: string[];\n  correct_index?: number;\n  numeric_answer?: number | null;\n  explanation: string;\n};\n\nReturn: {\"questions\": Question[]}\n\nRules:\n- Use provided `sections` ids to distribute coverage.\n- Russian language.\n- mcq: 3-4 options + correct_index.\n- numeric: nice numbers; include numeric_answer.\n- explanation: brief.\n" },
          { role:'user', content: JSON.stringify({ sections, count }) }
        ],
        temperature:0.7
      })
    })
    const j = await r.json()
    const raw = j?.choices?.[0]?.message?.content || ''
    let parsed; try{ parsed = JSON.parse(raw) }catch(e){ return res.status(502).json({ error:'Bad JSON from model', raw }) }
    const safe = RespSchema.parse(parsed)
    res.json(safe)
  }catch(e){ res.status(500).json({ error:String(e) }) }
})

app.post('/check-answer', async (req,res)=>{
  try{
    const { question, userAnswer } = req.body || {}
    if(!process.env.DEEPSEEK_API_KEY) throw new Error('No DEEPSEEK_API_KEY')
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method:'POST',
      headers:{ 'Authorization':`Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        model:'deepseek-chat',
        messages:[
          { role:'system', content:"\n\u0422\u044b \u043f\u0440\u043e\u0432\u0435\u0440\u044f\u0435\u0448\u044c \u043e\u0442\u0432\u0435\u0442\u044b \u043f\u043e \u0442\u0435\u043e\u0440\u0438\u0438 \u0432\u0435\u0440\u043e\u044f\u0442\u043d\u043e\u0441\u0442\u0435\u0439.\n\u0412\u0435\u0440\u043d\u0438 \u0421\u0422\u0420\u041e\u0413\u0418\u0419 JSON:\n{\n  \"correct\": boolean,\n  \"explanation\": string\n}\n\n\u041f\u0440\u0430\u0432\u0438\u043b\u0430:\n- \u0415\u0441\u043b\u0438 \u0432\u043e\u043f\u0440\u043e\u0441 \u0441 \u0432\u0430\u0440\u0438\u0430\u043d\u0442\u0430\u043c\u0438 (mcq), \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0439 \u043f\u043e\u043b\u0435 correct_index.\n- \u0415\u0441\u043b\u0438 numeric \u2014 \u0441\u0440\u0430\u0432\u043d\u0438 \u0441 numeric_answer (\u0434\u043e\u043f\u0443\u0441\u043a \u00b15%).\n- \u0415\u0441\u043b\u0438 short \u2014 \u043e\u0446\u0435\u043d\u0438 \u043f\u043e \u0441\u043c\u044b\u0441\u043b\u0443 \u0438 \u043a\u043b\u044e\u0447\u0435\u0432\u044b\u043c \u0441\u043b\u043e\u0432\u0430\u043c \u0438\u0437 \u043e\u0431\u044a\u044f\u0441\u043d\u0435\u043d\u0438\u044f.\n- \u041e\u0431\u044a\u044f\u0441\u043d\u0435\u043d\u0438\u0435 \u043d\u0430 \u0440\u0443\u0441\u0441\u043a\u043e\u043c, \u043a\u0440\u0430\u0442\u043a\u043e\u0435.\n- \u041d\u0418\u0427\u0415\u0413\u041e, \u043a\u0440\u043e\u043c\u0435 JSON.\n" },
          { role:'user', content: JSON.stringify({ question, userAnswer }) }
        ],
        temperature:0.3
      })
    })
    const j = await r.json()
    const raw = j?.choices?.[0]?.message?.content || ''
    let parsed; try{ parsed = JSON.parse(raw) }catch(e){ return res.status(502).json({ error:'Bad JSON from model', raw }) }
    const safe = CheckSchema.parse(parsed)
    res.json(safe)
  }catch(e){ res.status(500).json({ error:String(e) }) }
})

const port = process.env.PORT || 3000
app.listen(port, ()=>console.log('Backend running on', port))
