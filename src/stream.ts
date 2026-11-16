import { repairJson, type RepairOptions } from './lexer.js';

/**
 * Options for streaming JSON repair.
 */
export interface StreamRepairOptions extends RepairOptions {
  /**
   * Whether to deduplicate consecutive identical parsed outputs.
   * When true, only emits a new snapshot when the parsed JSON value has changed.
   * @default true
   */
  dedupe?: boolean;

  /**
   * Custom equality comparer for deduplication.
   * Defaults to deep structural equality.
   */
  isEqual?: (prev: unknown, next: unknown) => boolean;

  /**
   * If true, suppresses emitting null or fallback values before the first valid JSON token arrives.
   * Useful when LLM outputs conversational preamble before JSON.
   * @default true
   */
  ignorePreamble?: boolean;
}

/**
 * Fast deep-equality check for JSON-serializable structures (zero dependencies).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }

  const isArrA = Array.isArray(a);
  const isArrB = Array.isArray(b);
  if (isArrA !== isArrB) {
    return false;
  }

  if (isArrA && isArrB) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  const keysA = Object.keys(recordA);
  const keysB = Object.keys(recordB);

  if (keysA.length !== keysB.length) {
    return false;
  }

  for (let i = 0; i < keysA.length; i++) {
    const key = keysA[i]!;
    if (!Object.prototype.hasOwnProperty.call(recordB, key)) {
      return false;
    }
    if (!deepEqual(recordA[key], recordB[key])) {
      return false;
    }
  }

  return true;
}

/**
 * Creates a standard Web `TransformStream` that buffers incoming text/binary chunks,
 * repairs partial JSON into valid snapshot objects on each chunk, and deduplicates consecutive states.
 *
 * Compatible with all modern JS environments (Node.js 18+, Bun, Deno, Cloudflare Workers, Browsers).
 *
 * @example
 * ```ts
 * const repairStream = createJsonRepairStream<MyUserType>();
 * const reader = textStream.pipeThrough(repairStream).getReader();
 * ```
 */
export function createJsonRepairStream<T = unknown, In = string>(
  options: StreamRepairOptions = {}
): TransformStream<In, T> {
  const {
    dedupe = true,
    isEqual = deepEqual,
    ignorePreamble = true,
    ...repairOpts
  } = options;

  let buffer = '';
  let hasEmitted = false;
  let lastValue: unknown = undefined;
  let decoder: TextDecoder | undefined;

  return new TransformStream<In, T>({
    transform(chunk, controller) {
      if (chunk instanceof Uint8Array) {
        if (!decoder) {
          decoder = new TextDecoder('utf-8');
        }
        buffer += decoder.decode(chunk, { stream: true });
      } else {
        buffer += String(chunk);
      }

      const repaired = repairJson<T>(buffer, repairOpts);

      // If preamble is ignored and no valid JSON structure has been parsed yet, skip emitting
      if (repaired === null && ignorePreamble && !hasEmitted) {
        return;
      }

      // Deduplicate consecutive identical snapshots
      if (dedupe && hasEmitted && isEqual(lastValue, repaired)) {
        return;
      }

      lastValue = repaired;
      hasEmitted = true;
      controller.enqueue(repaired);
    },

    flush(controller) {
      if (decoder) {
        const remaining = decoder.decode();
        if (remaining) {
          buffer += remaining;
          const repaired = repairJson<T>(buffer, repairOpts);
          if (repaired !== null || !ignorePreamble) {
            if (!dedupe || !hasEmitted || !isEqual(lastValue, repaired)) {
              controller.enqueue(repaired);
            }
          }
        }
      }
    },
  });
}

/**
 * Ergonomic `for await...of` async generator helper that consumes a `ReadableStream`
 * or `AsyncIterable` of string or Uint8Array chunks, yielding newly repaired JSON snapshots.
 *
 * @example
 * ```ts
 * for await (const snapshot of parseJsonStream<UserProfile>(response.body)) {
 *   renderUser(snapshot);
 * }
 * ```
 */
export async function* parseJsonStream<T = unknown>(
  stream: ReadableStream<string | Uint8Array> | AsyncIterable<string | Uint8Array>,
  options: StreamRepairOptions = {}
): AsyncGenerator<T, void, unknown> {
  const {
    dedupe = true,
    isEqual = deepEqual,
    ignorePreamble = true,
    ...repairOpts
  } = options;

  let buffer = '';
  let hasEmitted = false;
  let lastValue: unknown = undefined;
  let decoder: TextDecoder | undefined;

  // Normalise ReadableStream vs AsyncIterable
  const iterator: AsyncIterable<string | Uint8Array> =
    Symbol.asyncIterator in stream
      ? stream
      : {
          [Symbol.asyncIterator]() {
            const reader = (stream as ReadableStream<string | Uint8Array>).getReader();
            return {
              async next() {
                const { done, value } = await reader.read();
                if (done) {
                  return { done: true, value: undefined };
                }
                return { done: false, value };
              },
              async return() {
                await reader.cancel();
                reader.releaseLock();
                return { done: true, value: undefined };
              },
            };
          },
        };

  for await (const chunk of iterator) {
    if (chunk instanceof Uint8Array) {
      if (!decoder) {
        decoder = new TextDecoder('utf-8');
      }
      buffer += decoder.decode(chunk, { stream: true });
    } else {
      buffer += String(chunk);
    }

    const repaired = repairJson<T>(buffer, repairOpts);

    if (repaired === null && ignorePreamble && !hasEmitted) {
      continue;
    }

    if (dedupe && hasEmitted && isEqual(lastValue, repaired)) {
      continue;
    }

    lastValue = repaired;
    hasEmitted = true;
    yield repaired;
  }

  // Flush any trailing multi-byte buffer from decoder
  if (decoder) {
    const remaining = decoder.decode();
    if (remaining) {
      buffer += remaining;
      const repaired = repairJson<T>(buffer, repairOpts);
      if (repaired !== null || !ignorePreamble) {
        if (!dedupe || !hasEmitted || !isEqual(lastValue, repaired)) {
          yield repaired;
        }
      }
    }
  }
}
