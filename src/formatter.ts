/**
 * Channel-agnostic message formatter using local Ollama.
 * Converts Claude's markdown output to channel-specific formatting
 * before sending. Falls back to raw text if Ollama is unavailable.
 */

import { OLLAMA_URL, OLLAMA_FORMATTER_MODEL } from './config.js';
import { logger } from './logger.js';

const FORMATTER_TIMEOUT = 10_000;

/**
 * Check if text contains markdown formatting that needs conversion.
 */
function hasMarkdownFormatting(text: string): boolean {
  return /(\*\*|__|^#{1,6}\s|```|~~|^\s*[-*+]\s|^\s*\d+\.\s|^\s*>|\[.*\]\(|---)/m.test(
    text,
  );
}

/**
 * Format text for a specific channel using Ollama.
 * Returns the original text unchanged if:
 * - No formatting spec provided
 * - Text has no markdown formatting
 * - Ollama is unavailable or times out
 */
export async function formatForChannel(
  text: string,
  spec?: string,
): Promise<string> {
  if (!spec || !hasMarkdownFormatting(text)) {
    return text;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FORMATTER_TIMEOUT);

    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_FORMATTER_MODEL,
        stream: false,
        prompt: `You are a text formatter. Convert the markdown formatting in the following message to the target format. ONLY change formatting syntax. Do not change, add, or remove any words or content. Do not add any explanation or commentary. Output ONLY the reformatted message.

TARGET FORMAT RULES:
${spec}

INPUT:
${text}

OUTPUT:`,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn(
        { status: response.status },
        'Ollama formatter returned non-OK status, using raw text',
      );
      return text;
    }

    const result = (await response.json()) as { response?: string };
    const formatted = result.response?.trim();

    if (!formatted) {
      return text;
    }

    return formatted;
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    logger.warn(
      { err: isAbort ? 'timeout' : err },
      'Ollama formatter unavailable, using raw text',
    );
    return text;
  }
}
