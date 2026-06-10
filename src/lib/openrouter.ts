const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenRouterResponse {
  model: string;
  choices: {
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export async function callModel(
  model: string,
  messages: ChatMessage[]
): Promise<OpenRouterResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter error (${response.status}): ${error}`);
  }

  return response.json() as Promise<OpenRouterResponse>;
}

export async function bugHunters(prompt: string): Promise<{
  gpt55: string;
  opus47: string;
}> {
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];

  const [gpt55Result, opus47Result] = await Promise.all([
    callModel("openai/gpt-5.5", messages),
    callModel("anthropic/claude-opus-4.7", messages),
  ]);

  return {
    gpt55: gpt55Result.choices[0]?.message?.content ?? "",
    opus47: opus47Result.choices[0]?.message?.content ?? "",
  };
}
