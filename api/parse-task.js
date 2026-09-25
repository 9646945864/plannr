export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const { text } = req.body || {};

  if (!text) {
    return res.status(400).json({
      error: "Missing text"
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "GEMINI_API_KEY is missing"
    });
  }

  const today = new Date().toISOString().slice(0, 10);

  const prompt = `
You are the calendar parser for Plannr.

Today is ${today}.

Return ONLY valid JSON.

The JSON must have exactly these fields:

{
  "action": "create",
  "title": "",
  "durationMinutes": 60,
  "date": null,
  "time": null,
  "deadline": null,
  "preferredTime": null,
  "targetTitle": null
}

Rules:

action:
- create = add a new task
- reschedule = move an existing task
- delete = remove an existing task

For create:
- title = task name
- durationMinutes = requested duration, default 60
- date = requested scheduled date, or null
- time = requested exact time, or null
- deadline = requested deadline, or null
- preferredTime = morning, afternoon, evening, or null
- targetTitle = null

For reschedule:
- targetTitle = name of existing task
- date = new date, or null
- time = new exact time, or null

For delete:
- targetTitle = name of existing task

Convert times to 24-hour format.

Examples:
4 PM -> 16:00
6 PM -> 18:00
9 AM -> 09:00
6:30 PM -> 18:30

Convert durations:
2 hours -> 120
90 minutes -> 90

Resolve relative dates such as tomorrow and weekdays using today's date.

Return ONLY the JSON object.

User command:
${JSON.stringify(text)}
`;

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=" +
        encodeURIComponent(apiKey),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json"
          }
        })
      }
    );

    const responseText = await response.text();

    if (!response.ok) {
      console.error("Gemini API error:", responseText);

      return res.status(response.status).json({
        error: responseText
      });
    }

    const data = JSON.parse(responseText);

    const output =
      data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!output) {
      console.error("No Gemini output:", data);

      return res.status(500).json({
        error: "Gemini returned no text"
      });
    }

    const parsed = JSON.parse(output);

    return res.status(200).json(parsed);

  } catch (error) {
    console.error("Parse task error:", error);

    return res.status(500).json({
      error: error.message
    });
  }
}
