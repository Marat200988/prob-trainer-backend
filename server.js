import express from "express";
import fetch from "node-fetch";
import cors from "cors";

// ---------- Config ----------
const PORT = process.env.PORT || 10000;
const DS_API_KEY = process.env.DEEPSEEK_API_KEY || process.env.DS_API_KEY;
const DS_URL = "https://api.deepseek.com/chat/completions";
const DS_MODEL = "deepseek-chat"; // быстрее, чем reasoning
const LANG = process.env.QUIZ_LANG || "ru";

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: process.env.ALLOW_ORIGIN || "*",
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------- Helpers ----------
function extractJSON(text) {
  if (!text) return null;
  let t = String(text).trim();

  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\s*/, "");
    t = t.replace(/```$/, "").trim();
  }
  if (t.toLowerCase().startsWith("json")) t = t.slice(4).trim();

  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    console.error("JSON parse error:", e);
    return null;
  }
}

let cache = { key: "", data: null, ts: 0 };
const CACHE_MS = 5 * 60 * 1000;

// Храним последний набор вопросов и быстрый индекс по id
let lastQuestions = [];
let lastById = new Map();

function buildSystemPrompt() {
  if (LANG === "ru") {
    return `Ты генератор тренировочных задач по вероятности для начинающих.
Верни ТОЛЬКО JSON без комментариев и текста, строго по схеме.

Сгенерируй 6 вопросов по секциям пользователя (id секций сохраняй).
Каждый вопрос: тип "mcq", 4 варианта, один верный ответ.
Коротко и понятно, на русском.

Схема:
{
  "questions": [
    {
      "id": "q1",
      "section_id": "bayes",
      "title": "Короткий заголовок",
      "question": "Текст вопроса (1–3 предложения).",
      "type": "mcq",
      "options": { "A":"…", "B":"…", "C":"…", "D":"…" },
      "answer": "A",
      "explanation_md": "Короткое объяснение в Markdown."
    }
  ]
}`;
  }
  return `You generate beginner probability questions.
Return JSON ONLY (no prose), matching:

{
  "questions": [
    {
      "id":"q1","section_id":"bayes","title":"Short title",
      "question":"Problem (1–3 sentences).","type":"mcq",
      "options":{"A":"…","B":"…","C":"…","D":"…"},
      "answer":"A","explanation_md":"Short Markdown explanation."
    }
  ]
}`;
}

function buildUserPrompt(body) {
  const count = Math.min(Math.max(Number(body?.count ?? 6), 1), 12);
  const sections = Array.isArray(body?.sections) ? body.sections : [];
  return JSON.stringify({
    instruction:
      LANG === "ru"
        ? `Сгенерируй ${count} вопросов, равномерно покрывая секции.`
        : `Generate ${count} questions, covering sections evenly.`,
    sections,
    count,
  });
}

async function callDeepSeek(messages) {
  const resp = await fetch(DS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DS_API_KEY}`,
    },
    body: JSON.stringify({
      model: DS_MODEL,
      messages,
      temperature: 0.7,
    }),
  });

  const head = await resp.text();
  console.info("INFO: DeepSeek status =", resp.status);
  console.info("INFO: DeepSeek raw body (head) =");
  console.info(head.slice(0, 2000));

  if (!resp.ok) throw new Error(`DeepSeek HTTP ${resp.status}`);

  let outer;
  try {
    outer = JSON.parse(head);
  } catch {
    const fallback = extractJSON(head);
    if (fallback) return fallback;
    throw new Error("Failed to parse DeepSeek API envelope");
  }

  const content = outer?.choices?.[0]?.message?.content ?? "";
  const parsed = extractJSON(content);
  if (!parsed) throw new Error("Failed to extract JSON from DeepSeek message");
  return parsed;
}

// ---------- Routes ----------

// Генерация вопросов
app.post("/gen-questions", async (req, res) => {
  try {
    const cacheKey = JSON.stringify(req.body || {});
    const now = Date.now();
    if (cache.key === cacheKey && cache.data && now - cache.ts < CACHE_MS) {
      return res.json(cache.data);
    }

    console.info("INFO: gen-questions body:", JSON.stringify(req.body));

    const data = await callDeepSeek([
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(req.body) },
    ]);

    const qsIn = Array.isArray(data?.questions) ? data.questions : [];
    const letters = ["A", "B", "C", "D"];

    // Нормализация
    const qs = qsIn.map((q, idx) => {
      const id = String(q?.id ?? `q${idx + 1}`);
      let options = q?.options;

      if (!options || Array.isArray(options)) {
        const obj = {};
        (options || []).slice(0, 4).forEach((opt, i) => {
          obj[letters[i]] = String(opt?.text ?? opt ?? "");
        });
        options = obj;
      } else {
        for (const k of Object.keys(options)) {
          options[k] = String(options[k]);
        }
      }

      const answer =
        (q?.answer ?? q?.correctAnswer ?? "A").toString().trim().toUpperCase();

      return {
        id,
        section_id: q?.section_id ?? req.body?.sections?.[0]?.id ?? "misc",
        title: q?.title ?? "",
        question: q?.question ?? "",
        type: "mcq",
        options,
        answer,
        explanation_md: q?.explanation_md ?? q?.explanation ?? "",
      };
    });

    // Обновляем кеш + индекс по id
    const payload = { questions: qs };
    cache = { key: cacheKey, data: payload, ts: now };

    lastQuestions = qs;
    lastById = new Map(qs.map((q) => [q.id, q]));

    console.debug("DEBUG: cached", qs.length, "questions");
    res.json(payload);
  } catch (err) {
    console.error("ERROR gen-questions:", err?.message || err);
    res.status(500).json({ error: "GEN_QUESTIONS_FAIL" });
  }
});

// Проверка ответа
app.post("/check-answer", async (req, res) => {
  try {
    const { qid, type, userAnswer, confidence, question } = req.body || {};

    // 1) если фронт прислал вопрос целиком — отлично
    // 2) иначе ищем по qid в последнем наборе
    const q =
      question ||
      (qid && (lastById.get(qid) || lastQuestions.find((x) => x.id === qid)));

    if (!q) {
      return res
        .status(404)
        .json({ error: "QUESTION_NOT_FOUND", qid: qid ?? null });
    }

    const correct = (q.answer || q.correctAnswer || "").toString().toUpperCase();
    const ua = (userAnswer || "").toString().toUpperCase();

    const isCorrect = correct && ua && correct === ua;

    const p = Math.min(Math.max(Number(confidence ?? 0.7), 0), 1);
    const y = isCorrect ? 1 : 0;
    const brier = (p - y) * (p - y);

    const correctText =
      q?.options && correct in q.options ? q.options[correct] : null;

    res.json({
      correct: isCorrect,
      correctAnswer: correct || null,
      correctText, // пригодится фронту, если захочешь показать текст варианта
      brier,
      explanation_md: q?.explanation_md || "",
    });
  } catch (err) {
    console.error("ERROR check-answer:", err?.message || err);
    res.status(500).json({ error: "CHECK_ANSWER_FAIL" });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
