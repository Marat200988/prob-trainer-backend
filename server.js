// server.js
// Minimal, fast, robust backend for Prob Trainer (DeepSeek)
// Node 18+ (global fetch available)

import express from "express";
import cors from "cors";

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 10000);
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
if (!DEEPSEEK_API_KEY) {
  console.error("ERROR: DEEPSEEK_API_KEY is not set");
  process.exit(1);
}

// ---------- APP ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------- IN-MEMORY STORE ----------
/**
 * store: Map<genId, { createdAt:number, items: Map<qid, {correctAnswer, explanation_md}> }>
 */
const store = new Map();
const GEN_TTL_MS = 1000 * 60 * 60; // 1 час

function makeGenId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function putPack(genId, payloadMap) {
  store.set(genId, { createdAt: Date.now(), items: payloadMap });
}

function getPack(genId) {
  const pack = store.get(genId);
  if (!pack) return null;
  if (Date.now() - pack.createdAt > GEN_TTL_MS) {
    store.delete(genId);
    return null;
  }
  return pack.items;
}

// периодическая очистка
setInterval(() => {
  const now = Date.now();
  for (const [genId, pack] of store.entries()) {
    if (now - pack.createdAt > GEN_TTL_MS) store.delete(genId);
  }
}, 60_000).unref();

// ---------- UTILS ----------
/** Достаёт JSON даже если пришло с «болтовнёй» или в ```json блоке */
function extractJson(text) {
  if (!text) return null;
  // попытка: найти ```json ... ```
  const fence = text.match(/```json([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch {}
  }
  // вырезать всё до первой { и после последней }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const maybe = text.slice(first, last + 1);
    try { return JSON.parse(maybe); } catch {}
  }
  // прямая попытка
  try { return JSON.parse(text); } catch {}
  return null;
}

/** Приводит options к объекту {A:"...",B:"...",...}; answer к ключу "A|B|..." */
function normalizeQuestion(q) {
  if (!q || typeof q !== "object") return null;
  const out = {
    id: String(q.id ?? ""),
    section_id: String(q.section_id ?? ""),
    title: String(q.title ?? ""),
    question: String(q.question ?? ""),
    content: q.content_md || q.content || "",
    type: q.type || "mcq",
    options: {},
    answer: "",
    explanation_md: q.explanation_md ? String(q.explanation_md) : "",
  };

  // options: массив -> A,B,C...
  if (Array.isArray(q.options)) {
    const letters = ["A","B","C","D","E","F","G","H"];
    q.options.forEach((t, i) => { out.options[letters[i]] = String(t ?? ""); });
  } else if (q.options && typeof q.options === "object") {
    for (const [k, v] of Object.entries(q.options)) out.options[String(k)] = String(v ?? "");
  }

  // answer: если пришёл текст — привести к ключу
  if (q.answer && typeof q.answer === "string") {
    const a = q.answer.trim();
    // если это один из ключей
    if (out.options[a] !== undefined) out.answer = a;
    else {
      // попробуем найти по значению текста
      const hit = Object.entries(out.options).find(([, v]) => v === a);
      if (hit) out.answer = hit[0];
    }
  }

  // sanity
  if (!out.id) out.id = cryptoRandomId();
  if (!out.type) out.type = "mcq";
  return out;
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 8);
}

// ---------- PROMPT ----------
function buildSystemPrompt(lang = "ru") {
  return (
`Ты — генератор учебных вопросов по вероятностному мышлению.
Отвечай ТОЛЬКО валидным JSON (без пояснений, без текста вокруг).
Структура ответа:

\`\`\`json
{
  "questions": [
    {
      "id": "q1",
      "section_id": "bayes",
      "title": "Короткий заголовок",
      "question": "Короткая постановка задачи одной-двумя фразами.",
      "type": "mcq",
      "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
      "answer": "A",
      "explanation_md": "Короткое понятное объяснение в Markdown."
    }
  ]
}
\`\`\`

Требования:
- language: ${lang};
- "options" строго объект с ключами "A","B","C","D";
- "answer" — ключ правильного варианта ("A"|"B"|"C"|"D");
- без LaTeX, без многострочных формул; максимум 2 предложения на поле "question".`
  );
}

function buildUserPrompt({ sections, count = 6 }) {
  const topics = sections?.map(s => {
    const t = s.title || s.id || "topic";
    return `- ${t}`;
  }).join("\n");
  return (
`Сгенерируй ${count} разноуровневых задач (mcq) по темам:
${topics || "- Общие вероятностные задачи"}
Следи, чтобы заголовок был коротким, а формулировка лаконичной.`
  );
}

// ---------- DEEPSEEK CALL ----------
async function deepseekCompletion({ system, user }) {
  const body = {
    model: DEEPSEEK_MODEL, // "deepseek-chat" by default
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.4,
    max_tokens: 1200,
    stream: false,
  };

  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const status = resp.status;
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`DeepSeek HTTP ${status}: ${text}`);
  }
  const data = await resp.json();
  const content =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.message ??
    "";
  return String(content || "");
}

// ---------- ROUTES ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.post("/gen-questions", async (req, res) => {
  try {
    const { sections = [], count = 6, lang = "ru" } = req.body || {};

    const system = buildSystemPrompt(lang);
    const user = buildUserPrompt({ sections, count });

    const raw = await deepseekCompletion({ system, user });
    console.info("INFO: DeepSeek raw body (head) =", raw.slice(0, 180).replace(/\n/g, " "));

    const parsed = extractJson(raw);
    if (!parsed || !Array.isArray(parsed.questions)) {
      throw new Error("bad_model_json");
    }

    const normalized = parsed.questions
      .map(normalizeQuestion)
      .filter(Boolean)
      .slice(0, count);

    // Подготовим кэш правильных ответов по genId
    const byId = new Map();
    for (const q of normalized) {
      byId.set(String(q.id), {
        correctAnswer: q.answer,
        explanation_md: q.explanation_md || "",
      });
      // чистим служебные поля перед отдачей
      delete q.answer;
      delete q.explanation_md;
    }
    const genId = makeGenId();
    putPack(genId, byId);

    res.json({ genId, questions: normalized });
  } catch (err) {
    console.error("ERROR /gen-questions:", err);
    res.status(500).json({ error: "failed_to_generate" });
  }
});

app.post("/check-answer", (req, res) => {
  try {
    const { genId, qid, userAnswer, confidence } = req.body || {};
    if (!genId || !qid) {
      return res.status(400).json({ error: "missing_genId_or_qid" });
    }
    const pack = getPack(String(genId));
    if (!pack) return res.status(404).json({ error: "genId_not_found" });

    const meta = pack.get(String(qid));
    if (!meta) return res.status(404).json({ error: "question_not_found" });

    const ua = String(userAnswer ?? "").trim();
    const ca = String(meta.correctAnswer ?? "").trim();
    const correct = ua && ca && ua === ca;

    let brier = undefined;
    if (typeof confidence === "number" && confidence >= 0 && confidence <= 1) {
      const p = confidence;
      brier = (p - (correct ? 1 : 0)) ** 2;
    }

    res.json({
      correct,
      correctAnswer: ca || null,
      explanation_md: meta.explanation_md || "",
      ...(typeof brier === "number" ? { brier } : {}),
    });
  } catch (err) {
    console.error("ERROR /check-answer:", err);
    res.status(500).json({ error: "failed_to_check" });
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`==> Server listening on port ${PORT}`);
});
