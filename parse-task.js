/* ============================================================
   /api/parse-task
   This runs on Vercel's server, NOT in the browser — so the
   Gemini API key stays hidden. The frontend (js/app.js) calls
   this endpoint instead of calling Gemini directly.
   ============================================================ */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { text } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Missing 'text' in request body" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server is missing GEMINI_API_KEY" });
  }

  const today = new Date().toISOString().slice(0, 10);

  // The prompt is written to force clean, parseable JSON —
  // no markdown fences, no extra commentary.
  const prompt = `You are a task-parsing engine for a student planner app.
Today's date is ${today}.

Read the following task description and return ONLY a JSON object
(no markdown, no code fences, no extra text) with exactly these fields:

{
  "title": string,                // short, clean task name
  "durationMinutes": number,      // your best estimate if not stated (default 60)
  "deadline": string or null,     // "YYYY-MM-DD" — resolve relative dates like "Thursday" using today's date
  "preferredTime": "morning" | "afternoon" | "evening" | null
}

Task description: "${text}"`;

  try {
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 },
        }),
      }
    );

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      console.error("Gemini API error:", errText);
      return res.status(502).json({ error: "Gemini API request failed" });
    }

    const data = await geminiResponse.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Strip accidental markdown fences just in case the model adds them.
    const cleaned = rawText.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("Could not parse Gemini output as JSON:", rawText);
      return res.status(502).json({ error: "Could not parse AI response" });
    }

    return res.status(200).json({
      title: parsed.title,
      durationMinutes: parsed.durationMinutes,
      deadline: parsed.deadline,
      preferredTime: parsed.preferredTime,
    });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
