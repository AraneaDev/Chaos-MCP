/**
 * Test-only helpers for reading MCP tool-result payloads.
 *
 * Not a test file — vitest only collects `*.test.ts`, and tsconfig.json
 * excludes `src/__tests__` from the build, so nothing here is emitted.
 */

/**
 * Structural stand-in for one MCP content block.
 *
 * The SDK types `content` as a union (text | image | audio | resource), and
 * only the text variant carries `text`. Declaring `text` optional here lets
 * every variant satisfy the shape while still forcing a runtime narrow.
 */
interface ContentBlockLike {
  type: string;
  text?: unknown;
}

/**
 * Read the text of a tool result's first content block.
 *
 * The handlers only ever emit text blocks, but `content[0].text` does not
 * type-check against the union. This narrows once, and throws a useful message
 * if a test ever receives a shape it did not expect — which is strictly better
 * than the `as string` casts this replaces, where a non-text block surfaced as
 * a confusing `undefined` deep inside an assertion.
 */
export function firstText(
  result: { content: readonly ContentBlockLike[] } | null | undefined,
): string {
  if (!result) throw new Error('expected a tool result, but got null/undefined');
  const block = result.content[0];
  if (!block) throw new Error('expected a content block, but content was empty');
  if (block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error(`expected a text content block, got type "${block.type}"`);
  }
  return block.text;
}
