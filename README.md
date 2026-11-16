# llm-json-repair-stream

> Production-ready, zero-dependency streaming JSON parser & repair engine designed for partial LLM outputs (OpenAI, Anthropic, Gemini, DeepSeek). Works across Node.js, Bun, Deno, Cloudflare Workers, and all modern browsers.

[![npm version](https://img.shields.io/npm/v/llm-json-repair-stream.svg)](https://www.npmjs.com/package/llm-json-repair-stream)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![bundle size](https://img.shields.io/bundlephobia/minzip/llm-json-repair-stream)](https://bundlephobia.com/package/llm-json-repair-stream)

---

## ⚡ The Problem

When streaming structured JSON from LLMs, chunks arrive mid-token (e.g. `{"user": {"name": "Al`, dangling colons, trailing commas, markdown code fences ` ```json `, or unescaped newlines inside strings). Standard `JSON.parse()` throws a `SyntaxError` on every intermediate chunk, forcing developers to wait until the entire stream completes before rendering anything.

`llm-json-repair-stream` solves this by using a fast, deterministic, single-pass **state-machine lexer** that repairs incomplete JSON on the fly, emitting valid snapshots on every chunk with built-in deduplication so your UI renders partial states smoothly and progressively.

---

## ✨ Features

- **Zero Dependencies:** Pure TypeScript using standard Web APIs (`TransformStream`, `ReadableStream`, `TextDecoder`).
- **State-Machine Lexer:** True character-by-character scanner (no naive regex substitutions).
- **Dual API Surface:**
  - `repairJson<T>()`: Synchronous snapshot repair for React state hooks and immediate parsing.
  - `createJsonRepairStream<T>()`: Standard Web `TransformStream` for native streaming pipelines.
  - `parseJsonStream<T>()`: Ergonomic `for await...of` async generator supporting `ReadableStream` and `AsyncIterable`.
- **Deduplication:** Automatically drops duplicate consecutive snapshot states so React doesn't trigger redundant re-renders.
- **Preamble & Fence Stripping:** Automatically removes conversational preamble (`Here is the JSON:`) and markdown code blocks (```` ```json ... ``` ````).
- **Universal Runtime:** Works in Node.js 18+, Bun, Deno, Cloudflare Workers, Electron, and browsers.
- **Battle-Hardened Repairs:**
  - Mid-string truncation (`{"user": "Al` $\to$ `{"user": "Al"}`)
  - Mid-key truncation (`{"id": 1, "na` $\to$ `{"id": 1}`)
  - Dangling colons (`{"id": 1, "name":` $\to$ `{"id": 1}`) or optional null assignment
  - Trailing commas (`[1, 2,]` $\to$ `[1, 2]`)
  - Incomplete literals (`tru` $\to$ `true`, `fals` $\to$ `false`, `nul` $\to$ `null`)
  - Incomplete numbers (`19.` $\to$ `19`, `1e` $\to$ `1`, `1.5e-` $\to$ `1.5`, `-` $\to$ `{}`)
  - Unescaped control characters inside strings (`\n`, `\r`, `\t` escaped automatically)
  - Python-style single quotes (`{'a': 'b'}`) and unquoted object keys (`{name: "Alice"}`)

---

## 📦 Installation

```bash
npm install llm-json-repair-stream
```

```bash
# Or via pnpm
pnpm add llm-json-repair-stream

# Or via Bun
bun add llm-json-repair-stream
```

---

## 🚀 10-Second Quickstart

### 1. Synchronous Snapshot Repair

```typescript
import { repairJson } from 'llm-json-repair-stream';

// Intermediate chunk received from an LLM
const chunk = '{"items": [{"id": 1}, {"id": 2, "title": "In prog';

const result = repairJson<{ items: Array<{ id: number; title?: string }> }>(chunk);

console.log(result);
// => { items: [{ id: 1 }, { id: 2, title: "In prog" }] }
```

### 2. Ergonomic Async Stream Iteration (`for await...of`)

```typescript
import { parseJsonStream } from 'llm-json-repair-stream';

interface UserProfile {
  name: string;
  tags: string[];
}

// Pass any ReadableStream or AsyncIterable (string or Uint8Array chunks)
for await (const snapshot of parseJsonStream<UserProfile>(response.body)) {
  console.log('Progressive snapshot:', snapshot);
  // Updates UI smoothly as tokens stream in!
}
```

### 3. Native Web `TransformStream` Pipeline

```typescript
import { createJsonRepairStream } from 'llm-json-repair-stream';

const repairStream = createJsonRepairStream<UserProfile>();

// Pipe directly through fetch or WebSocket streams
const reader = textStream.pipeThrough(repairStream).getReader();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log('Parsed snapshot:', value);
}
```

---

## 💡 Real-World Examples

### 1. Native `fetch` with OpenAI / Compatible SSE Stream

```typescript
import { parseJsonStream } from 'llm-json-repair-stream';

interface ReportSnapshot {
  title: string;
  summary: string;
  tags: string[];
}

async function streamJsonFromAPI() {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      stream: true,
      messages: [
        {
          role: 'system',
          content: 'Output a valid JSON object with keys: title, summary, tags.',
        },
        { role: 'user', content: 'Generate a market research report summary.' },
      ],
    }),
  });

  if (!response.body) throw new Error('Response body is null');

  // Convert raw SSE stream lines into clean content delta chunks
  async function* sseTextStream() {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (trimmed.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // Ignore malformed SSE comments
          }
        }
      }
    }
  }

  // Progressively parse partial JSON snapshots
  for await (const snapshot of parseJsonStream<ReportSnapshot>(sseTextStream())) {
    console.log('Live UI state:', snapshot);
  }
}
```

### 2. Vercel AI SDK (`streamText`)

```typescript
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { parseJsonStream } from 'llm-json-repair-stream';

const { textStream } = streamText({
  model: openai('gpt-4o-mini'),
  prompt: 'Generate 3 recommended restaurants in Tokyo as a JSON array of objects.',
});

for await (const restaurants of parseJsonStream<Array<{ name: string; cuisine: string }>>(textStream)) {
  updateRestaurantList(restaurants);
}
```

### 3. React Hook for Live Streaming UI

```tsx
import React, { useState, useEffect } from 'react';
import { parseJsonStream } from 'llm-json-repair-stream';

interface GeneratedReport {
  title: string;
  summary: string;
  metrics: { latency: number; accuracy: number };
}

export function LiveReportViewer({ streamUrl }: { streamUrl: string }) {
  const [report, setReport] = useState<Partial<GeneratedReport>>({});

  useEffect(() => {
    const controller = new AbortController();

    async function fetchStream() {
      const response = await fetch(streamUrl, { signal: controller.signal });
      if (!response.body) return;

      for await (const snapshot of parseJsonStream<GeneratedReport>(response.body)) {
        setReport(snapshot);
      }
    }

    fetchStream().catch(console.error);
    return () => controller.abort();
  }, [streamUrl]);

  return (
    <div className="card">
      <h2>{report.title || 'Generating title...'}</h2>
      <p>{report.summary || 'Writing summary...'}</p>
      {report.metrics && (
        <ul>
          <li>Latency: {report.metrics.latency ?? '...'}ms</li>
          <li>Accuracy: {report.metrics.accuracy ? `${report.metrics.accuracy * 100}%` : '...'}</li>
        </ul>
      )}
    </div>
  );
}
```

---

## 🛠️ API Reference

### `repairJson<T = unknown>(partialJson: string, options?: RepairOptions): T`

Synchronously repairs a partial JSON string and parses it into an object of type `T`. Never throws unhandled syntax errors during partial states.

```typescript
const snapshot = repairJson<MyType>('{"title": "Hel');
```

#### `RepairOptions`

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `incompleteValue` | `'omit' \| 'null'` | `'omit'` | Strategy for incomplete values at stream cutoff (e.g. dangling colon `{"key":` or incomplete minus `{"temp": -`). `'omit'` drops the key entirely; `'null'` assigns `null`. |
| `danglingKeyStrategy` | `'omit' \| 'null'` | `'omit'` | Alias for `incompleteValue`. |
| `fallback` | `unknown` | `null` | Default fallback value returned when input has no JSON structure (e.g., pure conversational text before JSON starts). |
| `onError` | `(err: Error, raw: string) => void` | `undefined` | Callback invoked if repair/parsing fails completely on non-JSON input. |
| `sanitizeControlChars` | `boolean` | `true` | Automatically escapes raw unescaped control characters (newlines `\n`, tabs `\t`) inside strings. |

---

### `repairJsonString(partialJson: string, options?: RepairOptions): string`

Returns the repaired, syntactically valid JSON string without calling `JSON.parse`. Useful if you want to inspect the string or pass it to a custom parser.

---

### `createJsonRepairStream<T = unknown>(options?: StreamRepairOptions): TransformStream<string | Uint8Array, T>`

Creates a standard Web `TransformStream` that buffers incoming text or binary chunks, repairs partial JSON on each chunk, and emits parsed snapshot objects.

#### `StreamRepairOptions` (extends `RepairOptions`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `dedupe` | `boolean` | `true` | Suppresses emitting identical consecutive snapshots. Prevents redundant UI re-renders when chunks don't alter parsed structure. |
| `isEqual` | `(a: unknown, b: unknown) => boolean` | `deepEqual` | Custom equality function used for deduplication. |
| `ignorePreamble` | `boolean` | `true` | Suppresses emitting `null` or fallback values before the first valid JSON token arrives. |

---

### `parseJsonStream<T = unknown>(stream: ReadableStream | AsyncIterable, options?: StreamRepairOptions): AsyncGenerator<T>`

An async generator helper for consuming a `ReadableStream` or `AsyncIterable` of string or `Uint8Array` chunks with standard `for await...of` syntax.

---

### `deepEqual(a: unknown, b: unknown): boolean`

Fast, zero-dependency deep structural equality comparer included with the library.

---

## 🧪 Testing

The library has a 100% pass rate across a comprehensive Vitest suite covering edge cases:

```bash
npm test
```

- **Basic & Nested Truncation:** Mid-string, mid-key, dangling colons, trailing commas, and deep nesting.
- **Literals & Numbers:** Partial booleans (`tru`, `fals`), null (`nul`), incomplete decimals (`19.`), scientific notation (`1e`, `1.5e-`), negative zero (`-0`), and dangling signs (`-`).
- **LLM Quirks:** Conversational chatter before `{` or `[`, markdown code fences (```` ```json ````), unquoted keys, single quotes, and unescaped control characters (`\n`, `\t`).
- **Split Escape Sequences (Audit Case 1):** Chunk ending with a single `\` does not escape closing quote before next chunk arrives.
- **Even vs. Odd Backslashes (Audit Case 2):** `{"path": "C:\\"}` properly closes string; `{"quote": "He said \"hi"}` stays inside string.
- **Braces & Brackets Inside Strings (Audit Case 3):** `{` and `[` inside quoted strings never corrupt the nesting stack.
- **High-Performance Large Streams (Audit Case 5):** 500KB+ JSON payloads repaired in milliseconds without quadratic memory/copy bottlenecks.
- **Chunk-Boundary Streaming:** Escaped quotes split across chunks, double backslashes split across chunks, and multi-byte UTF-8 emojis split across `Uint8Array` chunks.

---

## 📄 License

[MIT](./LICENSE)
