import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function getClient() {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_AI_API_KEY environment variable not set.");
  return new GoogleGenerativeAI(apiKey);
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export async function geminiSendPrompt(args: {
  prompt: string;
  model?: string;
  system_instruction?: string;
}): Promise<CallToolResult> {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({
    model: args.model ?? "gemini-2.0-flash",
    ...(args.system_instruction && { systemInstruction: args.system_instruction }),
  });

  const result = await model.generateContent(args.prompt);
  return ok(result.response.text());
}

export async function geminiChat(args: {
  messages: Array<{ role: "user" | "model"; content: string }>;
  model?: string;
  system_instruction?: string;
}): Promise<CallToolResult> {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({
    model: args.model ?? "gemini-2.0-flash",
    ...(args.system_instruction && { systemInstruction: args.system_instruction }),
  });

  const history = args.messages.slice(0, -1).map((m) => ({
    role: m.role,
    parts: [{ text: m.content }],
  }));

  const chat = model.startChat({ history });
  const lastMessage = args.messages.at(-1)!;
  const result = await chat.sendMessage(lastMessage.content);
  return ok(result.response.text());
}

export async function geminiAnalyzeText(args: {
  text: string;
  task: string;
  model?: string;
}): Promise<CallToolResult> {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: args.model ?? "gemini-2.0-flash" });

  const prompt = `${args.task}\n\nText to analyze:\n${args.text}`;
  const result = await model.generateContent(prompt);
  return ok(result.response.text());
}
