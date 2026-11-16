/**
 * Configuration options for JSON repair.
 */
export interface RepairOptions {
  /**
   * Strategy for handling incomplete values at the stream boundary
   * (e.g. dangling colons `{"key":` or incomplete negative signs `{"temp": -`).
   * - `'omit'`: drops the incomplete key-value pair entirely (`{}`)
   * - `'null'`: assigns `null` as the value (`{"key": null}`)
   * @default 'omit'
   */
  incompleteValue?: 'null' | 'omit';

  /**
   * Alias for `incompleteValue`.
   * - `'omit'`: drops the incomplete key-value pair entirely (`{}`)
   * - `'null'`: assigns `null` as the value (`{"key": null}`)
   * @default 'omit'
   */
  danglingKeyStrategy?: 'null' | 'omit';

  /**
   * Fallback value returned if the input contains no valid JSON structure
   * (e.g., conversational preamble before `{` or `[` is reached, or empty input).
   */
  fallback?: unknown;

  /**
   * Optional error hook invoked if input cannot be repaired into valid JSON.
   * Useful for logging or telemetry.
   */
  onError?: (error: Error, rawText: string) => void;

  /**
   * Whether to automatically sanitize and escape raw control characters
   * (such as literal unescaped newlines and tabs) inside strings.
   * @default true
   */
  sanitizeControlChars?: boolean;
}

interface ContainerFrame {
  type: 'object' | 'array';
  state:
    | 'EXPECT_KEY_OR_CLOSE'      // inside object: expecting key string or '}'
    | 'IN_KEY'                  // reading key string
    | 'EXPECT_COLON'            // key finished, expecting ':'
    | 'EXPECT_VALUE'            // inside object: saw ':', expecting value
    | 'EXPECT_ELEMENT_OR_CLOSE' // inside array: expecting value or ']'
    | 'AFTER_VALUE';            // expecting ',' or '}' / ']'

  /** Length of output buffer when preceding comma was emitted (-1 if none). */
  lastCommaOutLen: number;
  /** Length of output buffer when current key started (-1 if none). */
  keyStartOutLen: number;
}

/**
 * Escapes ASCII control characters (< 0x20) for standard JSON strings.
 */
function escapeControlChar(ch: string): string {
  switch (ch) {
    case '\b':
      return '\\b';
    case '\f':
      return '\\f';
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    default: {
      const code = ch.charCodeAt(0);
      return `\\u${code.toString(16).padStart(4, '0')}`;
    }
  }
}

/**
 * Extracts candidate JSON substring by stripping markdown code fences
 * and locating the earliest plausible JSON boundary.
 */
function extractJsonCandidate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  // 1. Check for markdown code fences (e.g. ```json ... ``` or partial ```json ...)
  const fenceStartMatch = /```(?:json|JSON)?[\r\n]*/.exec(raw);
  if (fenceStartMatch && fenceStartMatch.index !== undefined) {
    const afterFenceIndex = fenceStartMatch.index + fenceStartMatch[0].length;
    let content = raw.slice(afterFenceIndex);

    // Look for closing fence
    const closingFenceMatch = /```/.exec(content);
    if (closingFenceMatch && closingFenceMatch.index !== undefined) {
      content = content.slice(0, closingFenceMatch.index);
    } else {
      // Stream may be ending with partial backticks (`, ``, ```)
      content = content.replace(/`+$/, '');
    }

    const trimmedContent = content.trim();
    if (trimmedContent) {
      return trimmedContent;
    }
  }

  // 2. Check if trimmed input directly starts with standard JSON starter
  const firstChar = trimmed[0];
  if (
    firstChar === '{' ||
    firstChar === '[' ||
    firstChar === '"' ||
    firstChar === '-' ||
    (firstChar !== undefined && firstChar >= '0' && firstChar <= '9') ||
    trimmed.startsWith('true') ||
    trimmed.startsWith('false') ||
    trimmed.startsWith('null') ||
    trimmed === 't' ||
    trimmed === 'tr' ||
    trimmed === 'tru' ||
    trimmed === 'f' ||
    trimmed === 'fa' ||
    trimmed === 'fal' ||
    trimmed === 'fals' ||
    trimmed === 'n' ||
    trimmed === 'nu' ||
    trimmed === 'nul'
  ) {
    return trimmed;
  }

  // 3. Conversational preamble before '{' or '[' (e.g., "Here is the JSON: { ...")
  const firstBrace = raw.indexOf('{');
  const firstBracket = raw.indexOf('[');

  let startIndex = -1;
  if (firstBrace !== -1 && firstBracket !== -1) {
    startIndex = Math.min(firstBrace, firstBracket);
  } else if (firstBrace !== -1) {
    startIndex = firstBrace;
  } else if (firstBracket !== -1) {
    startIndex = firstBracket;
  }

  if (startIndex !== -1) {
    return raw.slice(startIndex).trim();
  }

  // Pure non-JSON text
  return null;
}

/**
 * Repairs an incomplete number literal at the stream boundary.
 * Returns null if the number is purely incomplete (like a lone '-') and cannot be completed to a number.
 */
function repairIncompleteNumber(numStr: string): string | null {
  let s = numStr.trim();
  if (s === '-' || s === '+' || s === '.' || s === '-.' || s === '+.') {
    return null;
  }

  // Strip trailing exponent parts: 1e, 1e+, 1.5e-
  s = s.replace(/[eE][+-]?$/, '');

  // Strip trailing decimal point: 19. -> 19, -19. -> -19
  s = s.replace(/\.$/, '');

  if (!s || s === '-' || s === '+') {
    return null;
  }

  return s;
}

/**
 * Repairs a partial JSON string into a syntactically valid JSON string.
 *
 * Runs an O(n) state-machine lexer that tracks nesting, quotes, escapes,
 * trailing commas, dangling colons, and incomplete literals with chunk slicing optimizations.
 *
 * @param partialJson The potentially incomplete or malformed JSON text.
 * @param options Repair configuration options.
 * @returns A repaired, valid JSON string.
 */
export function repairJsonString(partialJson: string, options: RepairOptions = {}): string {
  const candidate = extractJsonCandidate(partialJson);
  if (!candidate) {
    throw new Error('No valid JSON structure found');
  }

  const strategy = options.incompleteValue ?? options.danglingKeyStrategy ?? 'omit';
  const sanitizeControlChars = options.sanitizeControlChars ?? true;
  const len = candidate.length;

  let out = '';
  const stack: ContainerFrame[] = [];

  let i = 0;

  while (i < len) {
    const ch = candidate[i];
    if (ch === undefined) break;

    // Fast-path whitespace outside strings
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      const wsStart = i;
      while (i < len) {
        const c = candidate[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
          i++;
        } else {
          break;
        }
      }
      out += candidate.slice(wsStart, i);
      continue;
    }

    // Skip comments outside strings (e.g., // ... or /* ... */)
    if (ch === '/' && i + 1 < len) {
      const nextChar = candidate[i + 1];
      if (nextChar === '/') {
        i += 2;
        while (i < len && candidate[i] !== '\n' && candidate[i] !== '\r') {
          i++;
        }
        continue;
      }
      if (nextChar === '*') {
        i += 2;
        while (i < len && !(candidate[i] === '*' && candidate[i + 1] === '/')) {
          i++;
        }
        if (i < len) i += 2;
        continue;
      }
    }

    const currentFrame = stack[stack.length - 1];

    // String start (handles both double quotes and single quotes if emitted by LLM)
    if (ch === '"' || ch === "'") {
      const quoteChar = ch;
      const isKey = currentFrame?.type === 'object' && currentFrame.state === 'EXPECT_KEY_OR_CLOSE';

      if (isKey) {
        currentFrame.state = 'IN_KEY';
        currentFrame.keyStartOutLen = out.length;
      }

      const stringStartOutLen = out.length;
      out += '"'; // Standardize all strings to double quotes in output
      i++;

      let escapeCount = 0;
      let closed = false;
      let sliceStart = i;

      while (i < len) {
        const sc = candidate[i]!;

        if (sc === '\\') {
          // Flush normal text before escape
          if (i > sliceStart) {
            out += candidate.slice(sliceStart, i);
          }
          escapeCount++;
          out += '\\';
          i++;
          sliceStart = i;
          continue;
        }

        if (sc === quoteChar) {
          if (escapeCount % 2 === 1) {
            // Escaped quote
            if (i > sliceStart) {
              out += candidate.slice(sliceStart, i);
            }
            out += quoteChar === '"' ? '"' : "'";
            escapeCount = 0;
            i++;
            sliceStart = i;
            continue;
          } else {
            // Unescaped quote terminates string
            if (i > sliceStart) {
              out += candidate.slice(sliceStart, i);
            }
            out += '"';
            closed = true;
            escapeCount = 0;
            i++;
            sliceStart = i;
            break;
          }
        }

        // Inside string: handle raw control characters and invalid escapes
        if (escapeCount % 2 === 1) {
          // Previous char was backslash. Check if valid JSON escape character
          if (
            sc !== '"' &&
            sc !== '\\' &&
            sc !== '/' &&
            sc !== 'b' &&
            sc !== 'f' &&
            sc !== 'n' &&
            sc !== 'r' &&
            sc !== 't' &&
            sc !== 'u'
          ) {
            // Invalid escape: escape the backslash so JSON.parse won't throw
            // out already contains '\', add another '\' before sc
            if (i > sliceStart) {
              out += candidate.slice(sliceStart, i);
            }
            out += '\\' + sc;
            escapeCount = 0;
            i++;
            sliceStart = i;
            continue;
          }
        }

        escapeCount = 0;

        if (sanitizeControlChars && sc.charCodeAt(0) < 0x20) {
          if (i > sliceStart) {
            out += candidate.slice(sliceStart, i);
          }
          out += escapeControlChar(sc);
          i++;
          sliceStart = i;
        } else if (sc === '"' && quoteChar === "'") {
          // Inside single-quoted string, raw double quote must be escaped in standard JSON output
          if (i > sliceStart) {
            out += candidate.slice(sliceStart, i);
          }
          out += '\\"';
          i++;
          sliceStart = i;
        } else {
          i++;
        }
      }

      // Flush remaining slice
      if (i > sliceStart) {
        out += candidate.slice(sliceStart, i);
      }

      if (!closed) {
        // Stream ended while inside a string
        if (isKey && currentFrame) {
          // Incomplete key: omit incomplete key per requirements
          const rollbackPos =
            currentFrame.lastCommaOutLen >= 0
              ? currentFrame.lastCommaOutLen
              : currentFrame.keyStartOutLen;

          if (rollbackPos >= 0) {
            out = out.slice(0, rollbackPos);
          } else {
            out = out.slice(0, stringStartOutLen);
          }
          currentFrame.state = 'EXPECT_KEY_OR_CLOSE';
        } else {
          // Incomplete string value: close cleanly
          if (escapeCount % 2 === 1) {
            // Ended with dangling backslash (e.g. "msg": "line1\):
            // Strip the dangling backslash so we do NOT accidentally escape the closing quote!
            out = out.slice(0, -1) + '"';
          } else {
            out += '"';
          }

          if (currentFrame) {
            currentFrame.state = 'AFTER_VALUE';
            currentFrame.lastCommaOutLen = -1;
          }
        }
      } else {
        // String closed normally
        if (isKey && currentFrame) {
          currentFrame.state = 'EXPECT_COLON';
        } else if (currentFrame) {
          currentFrame.state = 'AFTER_VALUE';
          currentFrame.lastCommaOutLen = -1;
        }
      }

      // If root string is closed and there is no container stack, we are done
      if (stack.length === 0) {
        break;
      }
      continue;
    }

    // Object open '{'
    if (ch === '{') {
      if (currentFrame) {
        currentFrame.state = 'AFTER_VALUE';
        currentFrame.lastCommaOutLen = -1;
      }
      out += '{';
      stack.push({
        type: 'object',
        state: 'EXPECT_KEY_OR_CLOSE',
        lastCommaOutLen: -1,
        keyStartOutLen: -1,
      });
      i++;
      continue;
    }

    // Array open '['
    if (ch === '[') {
      if (currentFrame) {
        currentFrame.state = 'AFTER_VALUE';
        currentFrame.lastCommaOutLen = -1;
      }
      out += '[';
      stack.push({
        type: 'array',
        state: 'EXPECT_ELEMENT_OR_CLOSE',
        lastCommaOutLen: -1,
        keyStartOutLen: -1,
      });
      i++;
      continue;
    }

    // Colon ':'
    if (ch === ':') {
      if (currentFrame?.type === 'object' && currentFrame.state === 'EXPECT_COLON') {
        out += ':';
        currentFrame.state = 'EXPECT_VALUE';
        i++;
        continue;
      }
    }

    // Comma ','
    if (ch === ',') {
      if (currentFrame && currentFrame.state === 'AFTER_VALUE') {
        currentFrame.lastCommaOutLen = out.length;
        out += ',';
        if (currentFrame.type === 'object') {
          currentFrame.state = 'EXPECT_KEY_OR_CLOSE';
          currentFrame.keyStartOutLen = -1;
        } else {
          currentFrame.state = 'EXPECT_ELEMENT_OR_CLOSE';
        }
        i++;
        continue;
      }
    }

    // Object close '}'
    if (ch === '}') {
      if (currentFrame?.type === 'object') {
        // Check for trailing comma before '}'
        if (currentFrame.state === 'EXPECT_KEY_OR_CLOSE' && currentFrame.lastCommaOutLen >= 0) {
          out = out.slice(0, currentFrame.lastCommaOutLen);
        }
        out += '}';
        stack.pop();
        if (stack.length > 0) {
          const parent = stack[stack.length - 1];
          if (parent) {
            parent.state = 'AFTER_VALUE';
            parent.lastCommaOutLen = -1;
          }
        } else {
          // Root object completed! Stop parsing any trailing postamble.
          break;
        }
        i++;
        continue;
      }
    }

    // Array close ']'
    if (ch === ']') {
      if (currentFrame?.type === 'array') {
        // Check for trailing comma before ']'
        if (currentFrame.state === 'EXPECT_ELEMENT_OR_CLOSE' && currentFrame.lastCommaOutLen >= 0) {
          out = out.slice(0, currentFrame.lastCommaOutLen);
        }
        out += ']';
        stack.pop();
        if (stack.length > 0) {
          const parent = stack[stack.length - 1];
          if (parent) {
            parent.state = 'AFTER_VALUE';
            parent.lastCommaOutLen = -1;
          }
        } else {
          // Root array completed! Stop parsing any trailing postamble.
          break;
        }
        i++;
        continue;
      }
    }

    // Unquoted key in object (e.g., `{ name: "Alice" }` or `{ "a": 1, b: 2 }`)
    if (
      currentFrame?.type === 'object' &&
      currentFrame.state === 'EXPECT_KEY_OR_CLOSE' &&
      /[a-zA-Z_$]/.test(ch)
    ) {
      currentFrame.keyStartOutLen = out.length;
      let keyIdent = '';
      while (i < len) {
        const idChar = candidate[i];
        if (idChar !== undefined && /[a-zA-Z0-9_$-]/.test(idChar)) {
          keyIdent += idChar;
          i++;
        } else {
          break;
        }
      }
      out += `"${keyIdent}"`;
      currentFrame.state = 'EXPECT_COLON';
      continue;
    }

    // Number start: digit or '-'
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const numStart = i;
      while (i < len) {
        const nc = candidate[i];
        if (nc !== undefined && /[-+0-9.eE]/.test(nc)) {
          i++;
        } else {
          break;
        }
      }

      const numStr = candidate.slice(numStart, i);
      const repaired = repairIncompleteNumber(numStr);

      if (repaired !== null) {
        out += repaired;
        if (currentFrame) {
          currentFrame.state = 'AFTER_VALUE';
          currentFrame.lastCommaOutLen = -1;
        } else if (stack.length === 0) {
          break;
        }
      } else {
        // Incomplete number (e.g. lone '-' at cutoff)
        if (strategy === 'null') {
          out += 'null';
          if (currentFrame) {
            currentFrame.state = 'AFTER_VALUE';
            currentFrame.lastCommaOutLen = -1;
          }
        } else {
          // 'omit'
          if (currentFrame?.type === 'object') {
            const rollbackPos =
              currentFrame.lastCommaOutLen >= 0
                ? currentFrame.lastCommaOutLen
                : currentFrame.keyStartOutLen;
            if (rollbackPos >= 0) {
              out = out.slice(0, rollbackPos);
            }
            currentFrame.state = 'EXPECT_KEY_OR_CLOSE';
          } else if (currentFrame?.type === 'array') {
            if (currentFrame.lastCommaOutLen >= 0) {
              out = out.slice(0, currentFrame.lastCommaOutLen);
            }
            currentFrame.state = 'EXPECT_ELEMENT_OR_CLOSE';
          }
        }
      }
      continue;
    }

    // Booleans & Null literals: 'true', 'false', 'null'
    if (ch === 't' || ch === 'f' || ch === 'n') {
      let word = '';
      while (i < len) {
        const wc = candidate[i];
        if (wc !== undefined && /[a-zA-Z]/.test(wc)) {
          word += wc;
          i++;
        } else {
          break;
        }
      }

      if (word.startsWith('t')) {
        out += 'true';
      } else if (word.startsWith('f')) {
        out += 'false';
      } else if (word.startsWith('n')) {
        out += 'null';
      }

      if (currentFrame) {
        currentFrame.state = 'AFTER_VALUE';
        currentFrame.lastCommaOutLen = -1;
      } else if (stack.length === 0) {
        break;
      }
      continue;
    }

    // Handle special keywords sometimes output by LLMs (undefined, NaN, Infinity)
    if (ch === 'u' && candidate.slice(i, i + 9) === 'undefined') {
      out += 'null';
      i += 9;
      if (currentFrame) {
        currentFrame.state = 'AFTER_VALUE';
        currentFrame.lastCommaOutLen = -1;
      }
      continue;
    }
    if (ch === 'N' && candidate.slice(i, i + 3) === 'NaN') {
      out += 'null';
      i += 3;
      if (currentFrame) {
        currentFrame.state = 'AFTER_VALUE';
        currentFrame.lastCommaOutLen = -1;
      }
      continue;
    }
    if (ch === 'I' && candidate.slice(i, i + 8) === 'Infinity') {
      out += 'null';
      i += 8;
      if (currentFrame) {
        currentFrame.state = 'AFTER_VALUE';
        currentFrame.lastCommaOutLen = -1;
      }
      continue;
    }

    // Unknown/unmatched character: advance to prevent infinite loop
    i++;
  }

  // --- End of Stream: Close open containers and fix partial trailing states ---
  while (stack.length > 0) {
    const frame = stack.pop()!;

    if (frame.type === 'object') {
      if (frame.state === 'EXPECT_KEY_OR_CLOSE') {
        // Trailing comma before object close
        if (frame.lastCommaOutLen >= 0) {
          out = out.slice(0, frame.lastCommaOutLen);
        }
      } else if (frame.state === 'EXPECT_COLON' || frame.state === 'IN_KEY') {
        // Mid-key or key without colon: omit incomplete key
        const rollbackPos =
          frame.lastCommaOutLen >= 0 ? frame.lastCommaOutLen : frame.keyStartOutLen;
        if (rollbackPos >= 0) {
          out = out.slice(0, rollbackPos);
        }
      } else if (frame.state === 'EXPECT_VALUE') {
        // Dangling colon (e.g. `{"key":`)
        if (strategy === 'null') {
          out += 'null';
        } else {
          // 'omit'
          const rollbackPos =
            frame.lastCommaOutLen >= 0 ? frame.lastCommaOutLen : frame.keyStartOutLen;
          if (rollbackPos >= 0) {
            out = out.slice(0, rollbackPos);
          }
        }
      }

      out += '}';
    } else if (frame.type === 'array') {
      if (frame.state === 'EXPECT_ELEMENT_OR_CLOSE' && frame.lastCommaOutLen >= 0) {
        // Trailing comma before array close
        out = out.slice(0, frame.lastCommaOutLen);
      }
      out += ']';
    }
  }

  return out.trim();
}

/**
 * Synchronous snapshot repair for partial JSON strings.
 *
 * Repairs truncated strings, unclosed objects/arrays, trailing commas,
 * incomplete literals, and unescaped control characters.
 *
 * Never throws unhandled syntax errors during partial states. If input is completely
 * non-JSON, returns `fallback` (or `null`) and calls `onError` if supplied.
 *
 * @example
 * ```ts
 * const partial = '{"title": "Hel';
 * const snapshot = repairJson(partial);
 * // { title: "Hel" }
 * ```
 */
export function repairJson<T = unknown>(partialJson: string, options: RepairOptions = {}): T {
  try {
    const repairedString = repairJsonString(partialJson, options);
    return JSON.parse(repairedString) as T;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (options.onError) {
      options.onError(err, partialJson);
    }
    if (options.fallback !== undefined) {
      return options.fallback as T;
    }
    return null as T;
  }
}
