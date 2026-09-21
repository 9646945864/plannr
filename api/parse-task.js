/* ============================================================
   /api/parse-task
   Parses natural-language tasks using Gemini.
   ============================================================ */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { text } = req.body || {};

  if (!text || typeof text !== "string") {
    return res.status(400).json({
      error: "Missing 'text' in request body",
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "Server is missing GEMINI_API_KEY",
    });
  }

  const today = new Date().toISOString().slice(0, 10);

  const prompt = `
You are the task-parsing engine for an AI calendar app called Plannr.

Today's date is ${today}.

Parse the user's task and return ONLY valid JSON.

The JSON must have exactly these fields:

{
  "title": "short task name",
  "durationMinutes": 60,
  "deadline": "YYYY-MM-DD",
  "preferredTime": "morning"
}

Rules:

- title should be short and clear.
- durationMinutes should be a number.
- If the user does not give a duration, estimate one.
- If no duration is given, use 60 minutes.
- deadline must be YYYY-MM-DD or null.
- Resolve words such as today, tomorrow, Monday, Thursday, etc. using today's date.
- preferredTime must be "morning", "afternoon", "evening", or null.
- Do not include markdown.
- Do not include explanations.
- Return ONLY the JSON object.

User task:
${JSON.stringify(text)}
`;

  try {
    const geminiResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
        encodeURIComponent(apiKey),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();

      console.error("Gemini API error:", errorText);

      return res.status(502).json({
        error: "Gemini API request failed",
      });
    }

    const data = await geminiResponse.json();

    const rawText =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!rawText) {
      console.error("Gemini returned no text:", data);

      return res.status(502).json({
        error: "Gemini returned an empty response",
      });
    }

    let parsed;

    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      console.error("Invalid JSON from Gemini:", rawText);

      return res.status(502).json({
        error: "Could not parse AI response",
      });
    }

    // Validate the response before sending it to the frontend.

    if (typeof parsed.title !== "string") {
      return res.status(502).json({
        error: "AI returned an invalid title",
      });
    }

    if (
      typeof parsed.durationMinutes !== "number" ||
      parsed.durationMinutes <= 0
    ) {
      parsed.durationMinutes = 60;
    }

    if (
      parsed.preferredTime !== "morning" &&
      parsed.preferredTime !== "afternoon" &&
      parsed.preferredTime !== "evening" &&
      parsed.preferredTime !== null
    ) {
      parsed.preferredTime = null;
    }

    if (
      parsed.deadline !== null &&
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.deadline)
    ) {
      parsed.deadline = null;
    }

    return res.status(200).json({
      title: parsed.title,
      durationMinutes: parsed.durationMinutes,
      deadline: parsed.deadline,
      preferredTime: parsed.preferredTime,
    });
  } catch (err) {
    console.error("Server error:", err);

    return res.status(500).json({
      error: "Unexpected server error",
    });
  }
}
