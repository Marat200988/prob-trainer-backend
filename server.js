// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(express.json());

app.use(
  cors({
    origin: process.env.ALLOW_ORIGIN || "*",
  })
);

// ====== In-memory cache of the last generated questions ======
let lastQuestions = [];
let lastById = Object.create(null);

// Small helpers
const letters = ["A", "B", "C", "D", "E", "F", "G"];
const toStr = (v) => (v == null ? "" : String(v));

function normalizeOptions(raw) {
  // return object {A: "...", B: "...", ...}
  if (!raw) return {};
  // already object
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = {};
    for (const [k, v] of Object.entries(raw)) {
      obj[toStr(k).trim().toUpperCase()] = toStr(v);
    }
    return obj;
  }
  // array
  if (Array.isArray(raw)) {
    const obj = {};
    raw.slice(0, letters.length).forEach((opt, i) => {
      const text = typeof opt === "object" ? toStr(opt?.text ?? opt) : toStr(opt);
      obj[letters[i]] = text;
    });
    return obj;
  }
  // string (один вариант — не поддерживаем)
  return {};
}

function pickSectionId(reqBody, fallback = "misc") {
  const s = reqBody?.sections;
  if (Array.isArray(s) && s.length > 0) return s[0]?.id ?? fallback;
  return fallback;
}

// ====== Routes ======

// healthcheck
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// POST /gen-questions
// body: { sections:[{id,title,description,lessons:[...]}], count: 6 }
app.post("/gen-questions", async (req, res) => {
  console.info("INFO: gen-questions body:", JSON.stringify(req.body));

  try {
    // --- 1) Prompt to DeepSeek (chat, не reasoning) ---
    const prompt = `
Ты — генератор учебных задач по вероятности. Верни строго JSON, без \`\`\` и без текста вокруг.

Формат:
{
  "questions": [
    {
      "id": "q1",
      "section_id": "bayes",
      "title": "Короткий заголовок",
      "question": "Текст вопроса",
      "type": "mcq",
      "options": { "A":"...", "B":"...", "C":"...", "D":"..." },
      "answer": "A",
      "explanation_md": "Короткое объяснение в Markdown"
    }
  ]
}

Темы и контекст:
${JSON.stringify(req.body, null, 2)}

Требования:
- Всегда 4 варианта (A–D).
- Всегда заполняй title, question, options, answer, explanation_md.
- answer — буква из A–D.
- Строго верни валидный JSON по описанному ключу "questions".
    `.trim();

    const dsResp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "Ты аккуратно следуешь инструкциям и отвечаешь ровно в запрошенном формате." },
          { role: "user", content: prompt },
        ],
        temperature: 0.5,
      }),
    });

    console.info("INFO: DeepSeek status =", dsResp.status);
    const head = await dsResp.text();
    console.info("INFO: DeepSeek raw body (head) =", head.slice(0, 500));

    if (!dsResp.ok) {
      return res.status(502).json({ error: "LLM upstream error", status: dsResp.status });
    }

    // --- 2) Parse JSON from content ---
    let content = "";
    try {
      const data = JSON.parse(head);
      content = data?.choices?.[0]?.message?.content ?? "";
    } catch {
      // иногда DeepSeek уже дал объект; попробуем трактовать head как content
      content = head;
    }

    // Срезать возможные бэктики
    content = content.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      console.error("ERROR: parse content JSON fail:", e?.message);
      return res.status(500).json({ error: "Parse JSON fail from LLM" });
    }

    const qsIn = Array.isArray(parsed?.questions) ? parsed.questions : [];
    if (qsIn.length === 0) {
      return res.status(500).json({ error: "LLM returned empty questions" });
    }

    // --- 3) Normalize, force IDs q1..qn, normalize options as object ---
    const sectionFallback = pickSectionId(req.body, "misc");

    const qs = qsIn.map((q, idx) => {
      const id = `q${idx + 1}`; // Жёстко
      const options = normalizeOptions(q?.options);
      const answer = toStr(q?.answer ?? q?.correctAnswer ?? "A").trim().toUpperCase();

      return {
        id,
        section_id: toStr(q?.section_id ?? sectionFallback),
        title: toStr(q?.title),
        question: toStr(q?.question),
        type: "mcq",
        options,
        answer,
        explanation_md: toStr(q?.explanation_md ?? q?.explanation),
      };
    });

    // --- 4) Cache last set ---
    lastQuestions = qs;
    lastById = Object.create(null);
    for (const q of qs) lastById[q.id] = q;

    console.debug("DEBUG: cached", qs.length, "questions");

    res.json({ questions: qs });
  } catch (err) {
    console.error("ERROR: gen-questions:", err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// POST /check-answer
// body: { qid: "q1", userAnswer: "A", type: "mcq" }
app.post("/check-answer", async (req, res) => {
  try {
    const { qid, userAnswer } = req.body || {};
    console.info("INFO: check-answer body:", JSON.stringify(req.body));

    if (!qid || !userAnswer) {
      return res.status(400).json({ error: "qid and userAnswer are required" });
    }

    const q = lastById[qid];
    if (!q) {
      console.debug("DEBUG: question not found for qid:", qid);
      return res.status(404).json({ error: "question not found" });
    }

    const ua = toStr(userAnswer).trim().toUpperCase();
    const ca = toStr(q.answer).trim().toUpperCase();

    const correct = ua === ca;
    const correctText = q.options?.[ca] ?? "";
    const userText = q.options?.[ua] ?? "";

    const result = {
      correct,
      correctAnswer: ca,
      correctText,
      userAnswer: ua,
      userText,
      explanation_md: q.explanation_md || "",
    };

    console.debug("DEBUG: check-answer result", JSON.stringify(result));
    res.json(result);
  } catch (err) {
    console.error("ERROR: check-answer:", err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log("INFO: Server listening on port", port);
});
