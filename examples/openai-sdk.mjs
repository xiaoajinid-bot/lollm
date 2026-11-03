/**
 * Talk to a local lollm server with the official OpenAI SDK.
 *
 *   lollm pull qwen2.5:0.5b
 *   lollm serve &
 *   npm install openai   # only needed for this example
 *   node examples/openai-sdk.mjs
 */
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: process.env.LOLLM_URL ?? "http://127.0.0.1:11434/v1",
  apiKey: "local", // lollm does not check API keys
});

const models = await client.models.list();
const model = process.env.LOLLM_MODEL ?? models.data[0]?.id;
if (!model) {
  console.error("No models installed. Run: lollm pull qwen2.5:0.5b");
  process.exit(1);
}

console.log(`model: ${model}\n`);

const stream = await client.chat.completions.create({
  model,
  messages: [
    { role: "system", content: "You are a concise assistant." },
    { role: "user", content: "Explain in two sentences why GGUF is useful for local inference." },
  ],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
process.stdout.write("\n");
