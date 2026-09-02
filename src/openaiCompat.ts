/**
 * Some reasoning models (including GPT-5) only accept the default temperature
 * value and reject an explicit `temperature` field in the request.
 */
export function withOptionalTemperature<T extends Record<string, unknown>>(
  body: T,
  model: string,
  temperature: number
): T & Partial<{ temperature: number }> {
  if (/^(?:gpt-5|o\d)(?:[.-]|$)/i.test(model)) {
    return body;
  }
  return { ...body, temperature };
}
