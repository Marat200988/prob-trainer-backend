import express from "express";
import fetch from "node-fetch";
import cors from "cors";

// ====== Конфиг ======
const PORT = process.env.PORT || 10000;
const DS_API_KEY = process.env.DEEPSEEK_API_KEY || process.env.DS_API_KEY;
const DS_URL = "https://api.deepseek.com/chat/completions";
// быстрее и дешевле, чем reasoning:
const DS_MODEL = "deepseek-chat";
// "ru" или "en" — можно перекинуть в ENV, но по умолчанию русифицируем
const LANG = process.env.QUIZ_LANG || "ru";

// ====== App ======
const app = express();
app.use(express.json());
app.use(
  cors({
    origin: process.env.ALLOW_ORIGIN || "*",
  })
);

// healthcheck
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ====== Утилиты ======

/**
 * Достаёт JSON из строки DeepSeek.
 * Срезает обрамляющие ```json ... ``` или любые префиксы до первой { и последние }.
 */
function extractJSON(text) {
  if (!text) return null;
  let t = String(text).trim();

  // Срезаем маркдаун-кодблоки
  if (t.startsWith("```")) {
    // убираем первые ```... (включая возможное слово json)
    t = t.replace(/^```[a-zA-Z]*\s*/, "");
    // убираем завершающие ```
    t = t.replace(/```$/, "").trim();
  }

  // Иногда модель префиксит "json\n\n"
  if (t.toLowerCase().startsWith("json")) {
    t = t.slice(4).trim();
  }

  // На всякий случай берём подстроку по внешним { ... }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  const jsonString = t.slice(start, end + 1);
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    console.error("JSON parse error:", e);
    return null;
  }
}

/**
 * Вопросы кешируем на 5 минут, чтобы фронт не ждал каждый раз.
 * Простейший in-memory кеш на процесс.
 */
let cache = { key: "", data: null, ts: 0 };
const CACHE_MS = 5 * 60 * 1000;

// ====== Промпт для генерации ======
function buildSystemPrompt() {
  if (LANG === "ru") {
    return `Ты генератор тренировочных задач по вероятности для начинающих.
Верни ТОЛЬКО JSON без комментариев и текста, четко по схеме ниже.

Сгенерируй 6 вопросов по секциям, которые пришлет пользователь (id секций важен).
Каждый вопрос: тип "mcq", 4 варианта, один верный ответ.
Пиши коротко и понятно, на русском.

JSON-схема ответа:
{
  "questions": [
    {
      "id": "q1",                      // уникальный id в пределах ответа
      "section_id": "bayes",           // как в секциях пользователя
      "title": "Короткий заголовок",
      "question": "Текст вопроса (1–3 предложения).",
      "type": "mcq",
      "options": { "A":"…", "B":"…", "C":"…", "D":"…" },
      "answer": "A",
      "explanation_md": "Короткое объяснение в Markdown."
    }
  ]
}`;
  } else {
    return `You are a generator of beginner-friendly probability practice questions.
Return JSON ONLY (no prose, no comments), matching the schema below.

Generate 6 questions distributed over user-provided sections (keep section_id exactly).
Each question: type "mcq", 4 options, one correct answer. Language: English.

Schema:
{
  "questions": [
    {
      "id": "q1",
      "section_id": "bayes",
      "title": "Short title",
      "question": "Problem text (1–3 sentences).",
      "type": "mcq",
      "options": { "A":"…", "B":"…", "C":"…", "D":"…" },
      "answer": "A",
      "explanation_md": "Short explanation in Markdown."
    }
  ]
}`;
  }
}

function buildUserPrompt(body) {
  // Тело запроса с фронта: { sections: [{id,title,description,lessons:[...]}], count: 6 }
  const count = Math.min(Math.max(Number(body?.count ?? 6), 1), 12);
  const sections = Array.isArray(body?.sections) ? body.sections : [];
  return JSON.stringify({
    instruction:
      LANG === "ru"
        ? `Сгенерируй ${count} вопросов, равномерно используя эти секции.`
        : `Generate ${count} questions, covering these sections evenly.`,
    sections,
    count,
  });
}

// ====== DeepSeek вызов ======
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

  const head = await resp.text(); // читаем как текст (может быть обрамлено)
  // Запишем в логи "голову" (первые 2к)
  console.info("INFO: DeepSeek status =", resp.status);
  console.info("INFO: DeepSeek raw body (head) =");
  console.info(head.slice(0, 2000));

  if (!resp.ok) {
    throw new Error(`DeepSeek HTTP ${resp.status}`);
  }

  // Парсим нормальный JSON из тела DeepSeek API (внешняя оболочка)
  let outer;
  try {
    outer = JSON.parse(head);
  } catch {
    // Бывает, что приходит уже «чистый» JSON-блок без API-оболочки (редко),
    // попробуем выдрать внутренний JSON сразу.
    const fallback = extractJSON(head);
    if (fallback) return fallback;
    throw new Error("Failed to parse DeepSeek API envelope");
  }

  const content = outer?.choices?.[0]?.message?.content ?? "";
  const parsed = extractJSON(content);
  if (!parsed) {
    throw new Error("Failed to extract JSON from DeepSeek message");
  }
  return parsed;
}

// ====== Эндпоинты ======

// Генерация вопросов
app.post("/gen-questions", async (req, res) => {
  try {
    const cacheKey = JSON.stringify(req.body || {});
    const now = Date.now();
    if (cache.key === cacheKey && cache.data && now - cache.ts < CACHE_MS) {
      return res.json(cache.data);
    }

    console.info("INFO: gen-questions body:", JSON.stringify(req.body));

    const system = buildSystemPrompt();
    const user = buildUserPrompt(req.body);

    const data = await callDeepSeek([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);

    // Быстрая валидация и нормализация options
    const qs = Array.isArray(data?.questions) ? data.questions : [];
    for (const q of qs) {
      // приводим к ожидаемой фронтом форме
      if (!q.options || Array.isArray(q.options)) {
        // если прилетели массивом — превратим в A,B,C,D
        const letters = ["A", "B", "C", "D"];
        const obj = {};
        (q.options || []).slice(0, 4).forEach((opt, i) => {
          obj[letters[i]] = String(opt?.text ?? opt ?? "");
        });
        q.options = obj;
      } else {
        // убедимся, что значения — строки
        for (const k of Object.keys(q.options)) {
          q.options[k] = String(q.options[k]);
        }
      }
      // страхуем поля
      q.type = "mcq";
      q.title = q.title ?? "";
      q.question = q.question ?? "";
      q.explanation_md = q.explanation_md ?? "";
    }

    const payload = { questions: qs };

    cache = { key: cacheKey, data: payload, ts: now };
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
    // В идеале фронт присылает весь вопрос, но достаточно correctAnswer
    const correct = question?.answer ?? question?.correctAnswer;

    const isCorrect =
      typeof correct === "string" && typeof userAnswer === "string"
        ? correct.trim().toUpperCase() === userAnswer.trim().toUpperCase()
        : false;

    const p = Math.min(Math.max(Number(confidence ?? 0.7), 0), 1);
    const y = isCorrect ? 1 : 0;
    const brier = (p - y) * (p - y);

    res.json({
      correct: isCorrect,
      correctAnswer: correct ?? null,
      brier,
      explanation_md: question?.explanation_md ?? "",
    });
  } catch (err) {
    console.error("ERROR check-answer:", err?.message || err);
    res.status(500).json({ error: "CHECK_ANSWER_FAIL" });
  }
});

// ====== Start ======
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
