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

let LAST_QUESTIONS = [];

// -------- helpers ----------
function stripCodeFences(s = "") {
  return s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}

function tryParseJSON(s = "") {
  if (!s) return null;
  // часто модель присылает текст + JSON в код-блоке
  let t = stripCodeFences(s);
  // если вокруг есть пояснения, пытаемся выдрать первый большой JSON
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    t = t.slice(first, last + 1);
  }
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function normalizeOptions(raw) {
  if (!raw) return [];
  if (Array.isArray(raw))
    return raw.map((v, i) => ({
      key: ["A", "B", "C", "D", "E", "F", "G"][i] || String(i + 1),
      text: String(v ?? ""),
    }));
  if (typeof raw === "object")
    return Object.entries(raw).map(([k, v]) => ({
      key: String(k),
      text: String(v ?? ""),
    }));
  return [];
}

function plainFromMd(md = "") {
  return String(md || "")
    .replace(/`{1,3}.*?`{1,3}/gs, "")
    .replace(/[*_#>\[\]()`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeQuestion(q, i) {
  const id = q.id || `q${i + 1}`;
  const section_id = q.section_id || "misc";
  const options = normalizeOptions(q.options);
  const content_md = q.content_md || q.contentMd || q.content || "";
  const title =
    q.title ||
    (q.question ? String(q.question) : "") ||
    plainFromMd(content_md).split(". ").slice(0, 1).join(". ") ||
    `Вопрос ${i + 1}`;
  const question = q.question || ""; // оставим как прислал LLM (может быть пустым)
  const type = q.type || "mcq";
  const answer = q.answer || null; // может пригодиться в чекере

  return {
    id,
    section_id,
    title,
    question,
    content_md,
    options, // [{key, text}]
    type,
    answer,
  };
}

// -------- routes ----------
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post("/gen-questions", async (req, res) => {
  try {
    console.log("INFO: gen-questions body:", JSON.stringify(req.body));

    const body = {
      model: "deepseek-chat", // быстрее, чем deepseek-reasoner
      messages: [
        {
          role: "system",
          content:
            "Ты генератор тренировочных задач по вероятности. Отвечай ТОЛЬКО валидным JSON без пояснений.",
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              instruction:
                "Сгенерируй N=6 разных задач по вероятности с ответами. Каждая задача — формат 'mcq'.",
              format: {
                questions: [
                  {
                    id: "q1",
                    section_id: "bayes",
                    title: "Короткий заголовок",
                    question: "Один абзац формулировки (может быть пустым)",
                    content_md:
                      "Полный текст в Markdown (можно объединить с формулировкой).",
                    options: {
                      A: "вариант",
                      B: "вариант",
                      C: "вариант",
                      D: "вариант",
                    },
                    answer: "A",
                    explanation_md:
                      "Короткое объяснение решения и формулами в Markdown.",
                    type: "mcq",
                  },
                ],
              },
              language: "ru",
              sections: req.body?.sections || [],
              count: req.body?.count || 6,
            },
            null,
            2
          ),
        },
      ],
      temperature: 0.6,
      max_tokens: 2000,
    };

    const dsResp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    console.log("INFO: DeepSeek status =", dsResp.status);
    const respText = await dsResp.text();
    console.log("INFO: DeepSeek raw body (head) =", respText.slice(0, 200));

    if (!dsResp.ok) {
      return res
        .status(dsResp.status)
        .json({ error: "DeepSeek API error", detail: respText });
    }

    // Разбираем JSON DeepSeek и достаем message.content (тоже JSON-строка)
    let outer;
    try {
      outer = JSON.parse(respText);
    } catch {
      // крайне редко, но на всякий тюнинг
      outer = tryParseJSON(respText);
    }
    const content = outer?.choices?.[0]?.message?.content || "";
    const parsed = tryParseJSON(content);

    if (!parsed?.questions?.length) {
      return res
        .status(502)
        .json({ error: "Invalid model response", content: content.slice(0, 300) });
    }

    const questions = parsed.questions.map(normalizeQuestion);
    LAST_QUESTIONS = questions; // используем в /check-answer

    console.log("DEBUG: cached", questions.length, "questions");
    res.json({ questions });
  } catch (err) {
    console.error("gen-questions ERROR:", err);
    res.status(500).json({ error: String(err) });
  }
});

app.post("/check-answer", async (req, res) => {
  try {
    const { questionId, userAnswer } = req.body || {};
    const q = LAST_QUESTIONS.find((x) => x.id === questionId);

    if (!q) {
      return res
        .status(404)
        .json({ error: "Question not found (maybe cache reset)" });
    }

    // сравниваем по ключу опции (A/B/C/...)
    const correctAnswer = q.answer || null; // если модель прислала
    const correct =
      correctAnswer &&
      String(correctAnswer).trim().toUpperCase() ===
        String(userAnswer).trim().toUpperCase();

    // простой Brier без вероятности (слайдер вы не присылаете на бэк)
    const brier = Number(correct ? 0 : 0.49);

    res.json({
      correct: Boolean(correct),
      correctAnswer: correctAnswer || null,
      brier,
      explanation_md: q.explanation_md || "",
    });
  } catch (err) {
    console.error("check-answer ERROR:", err);
    res.status(500).json({ error: String(err) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server listening on port", port);
});
