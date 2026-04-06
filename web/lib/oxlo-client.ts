/** Oxlo AI client for the Next.js web app (mirrors src/oxlo/client.ts). */

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
}

export class OxloClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.OXLO_API_KEY;
    if (!apiKey) throw new Error('OXLO_API_KEY is not set');
    this.apiKey = apiKey;
    this.baseUrl = process.env.OXLO_BASE_URL ?? 'https://portal.oxlo.ai/v1';
    this.model = process.env.OXLO_MODEL ?? 'oxlo-1';
  }

  async chat(messages: Message[], system?: string): Promise<string> {
    const allMessages: Message[] = system
      ? [{ role: 'system', content: system }, ...messages]
      : messages;

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, messages: allMessages, temperature: 0.2 }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Oxlo API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const content = data.choices[0]?.message?.content;
    if (!content) throw new Error('Oxlo returned empty response');
    return content;
  }
}
