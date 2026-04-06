import axios, { type AxiosInstance } from 'axios';

/** A single message in a chat conversation. */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ChatCompletionChoice {
  message: {
    content: string;
  };
  delta?: {
    content?: string;
  };
}

interface ChatCompletionResponse {
  choices: ChatCompletionChoice[];
}

/**
 * Wrapper around the Oxlo.ai Chat Completions API.
 * All four pipeline calls (classify, extract, score, deduplicate) go through this client.
 *
 * Required environment variables:
 *   OXLO_API_KEY   — your Oxlo API key from portal.oxlo.ai
 *   OXLO_BASE_URL  — defaults to https://portal.oxlo.ai/v1
 *   OXLO_MODEL     — defaults to oxlo-1
 */
export class OxloClient {
  private readonly http: AxiosInstance;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.OXLO_API_KEY;
    if (!apiKey) {
      throw new Error('OXLO_API_KEY environment variable is required');
    }

    this.http = axios.create({
      baseURL: process.env.OXLO_BASE_URL ?? 'https://portal.oxlo.ai/v1',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
    });

    this.model = process.env.OXLO_MODEL ?? 'oxlo-1';
  }

  /**
   * Sends a chat completion request and returns the full response text.
   *
   * @param messages - Conversation turns (user/assistant)
   * @param system   - Optional system prompt prepended as a system role message
   * @returns The model's response text
   */
  async chat(messages: Message[], system?: string): Promise<string> {
    const allMessages: Message[] = system
      ? [{ role: 'system', content: system }, ...messages]
      : messages;

    const response = await this.http.post<ChatCompletionResponse>('/chat/completions', {
      model: this.model,
      messages: allMessages,
      temperature: 0.2,
    });

    const content = response.data.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Oxlo API returned an empty response');
    }
    return content;
  }

  /**
   * Sends a streaming chat completion request, calling onChunk for each text delta.
   *
   * @param messages - Conversation turns (user/assistant)
   * @param system   - System prompt
   * @param onChunk  - Called with each streamed text chunk
   */
  async chatStream(
    messages: Message[],
    system: string,
    onChunk: (chunk: string) => void
  ): Promise<void> {
    const allMessages: Message[] = [{ role: 'system', content: system }, ...messages];

    const response = await this.http.post<NodeJS.ReadableStream>(
      '/chat/completions',
      {
        model: this.model,
        messages: allMessages,
        temperature: 0.2,
        stream: true,
      },
      { responseType: 'stream' }
    );

    await new Promise<void>((resolve, reject) => {
      response.data.on('data', (chunk: Buffer) => {
        const lines = chunk
          .toString()
          .split('\n')
          .filter((line) => line.startsWith('data: '));

        for (const line of lines) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            resolve();
            return;
          }
          try {
            const parsed = JSON.parse(data) as { choices: Array<{ delta?: { content?: string } }> };
            const content = parsed.choices[0]?.delta?.content;
            if (content) onChunk(content);
          } catch {
            // Skip malformed SSE lines
          }
        }
      });

      response.data.on('end', resolve);
      response.data.on('error', reject);
    });
  }
}
