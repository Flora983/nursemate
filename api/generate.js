export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { system, messages, max_tokens } = req.body;

  const openaiMessages = [];
  if (system) openaiMessages.push({ role: "system", content: system });
  messages.forEach(m => openaiMessages.push(m));

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: max_tokens || 1000,
      messages: openaiMessages,
    }),
  });

  const data = await response.json();
  
  // Vertaal OpenAI response naar Anthropic formaat
  const text = data.choices?.[0]?.message?.content || "Error loading response.";
  res.status(200).json({ content: [{ type: "text", text }] });
}
