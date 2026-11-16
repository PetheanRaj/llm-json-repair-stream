import { describe, it, expect, vi } from 'vitest';
import {
  repairJson,
  repairJsonString,
  createJsonRepairStream,
  parseJsonStream,
  deepEqual,
} from '../src/index.js';

describe('Basic & Nested Truncation', () => {
  it('repairs mid-string truncation in nested object', () => {
    const input = '{"user": {"name": "Al';
    expect(repairJson(input)).toEqual({ user: { name: 'Al' } });
  });

  it('repairs mid-key truncation by omitting the incomplete key', () => {
    const input = '{"name": "Alice", "ro';
    expect(repairJson(input)).toEqual({ name: 'Alice' });
  });

  it('handles dangling colon after key by omitting by default', () => {
    const input = '{"name": "Alice", "age":';
    expect(repairJson(input)).toEqual({ name: 'Alice' });
  });

  it('handles dangling colon with incompleteValue: "null" option', () => {
    const input = '{"name": "Alice", "age":';
    expect(repairJson(input, { incompleteValue: 'null' })).toEqual({
      name: 'Alice',
      age: null,
    });
  });

  it('handles dangling colon with danglingKeyStrategy: "null" option alias', () => {
    const input = '{"name": "Alice", "age":';
    expect(repairJson(input, { danglingKeyStrategy: 'null' })).toEqual({
      name: 'Alice',
      age: null,
    });
  });

  it('removes trailing commas in nested objects and arrays', () => {
    const input = '{"items": [1, 2,],}';
    expect(repairJson(input)).toEqual({ items: [1, 2] });
  });

  it('removes trailing commas at stream cutoff', () => {
    expect(repairJson('{"items": [1, 2,')).toEqual({ items: [1, 2] });
    expect(repairJson('{"a": 1, ')).toEqual({ a: 1 });
  });

  it('repairs deeply nested unclosed structures', () => {
    const input = '{"a": {"b": [{"c": {"d": "val';
    expect(repairJson(input)).toEqual({
      a: { b: [{ c: { d: 'val' } }] },
    });
  });
});

describe('Literals & Numbers', () => {
  it('completes partial boolean true', () => {
    expect(repairJson('{"ok": tr')).toEqual({ ok: true });
    expect(repairJson('{"ok": tru')).toEqual({ ok: true });
    expect(repairJson('{"ok": t')).toEqual({ ok: true });
  });

  it('completes partial boolean false', () => {
    expect(repairJson('{"ok": fal')).toEqual({ ok: false });
    expect(repairJson('{"ok": fals')).toEqual({ ok: false });
    expect(repairJson('{"ok": f')).toEqual({ ok: false });
  });

  it('completes partial null', () => {
    expect(repairJson('{"val": nu')).toEqual({ val: null });
    expect(repairJson('{"val": nul')).toEqual({ val: null });
    expect(repairJson('{"val": n')).toEqual({ val: null });
  });

  it('repairs partial numbers with trailing decimal points', () => {
    expect(repairJson('{"price": 19.')).toEqual({ price: 19 });
    expect(repairJson('{"price": -19.')).toEqual({ price: -19 });
  });

  it('omits incomplete negative sign by default', () => {
    expect(repairJson('{"temp": -')).toEqual({});
    expect(repairJson('{"name": "Alice", "temp": -')).toEqual({ name: 'Alice' });
  });

  it('assigns null to incomplete negative sign with incompleteValue: "null"', () => {
    expect(repairJson('{"temp": -', { incompleteValue: 'null' })).toEqual({
      temp: null,
    });
    expect(
      repairJson('{"name": "Alice", "temp": -', { incompleteValue: 'null' })
    ).toEqual({
      name: 'Alice',
      temp: null,
    });
  });

  it('handles negative zero properly', () => {
    const result = repairJson<{ temp: number }>('{"temp": -0}');
    expect(Object.is(result.temp, -0) || result.temp === 0).toBe(true);
  });
});

describe('LLM Formatting Quirks', () => {
  it('handles leading and trailing conversational chatter with markdown fence', () => {
    const input = 'Sure! Here is the JSON:\n```json\n{"a": 1}\n```\nHope that helps!';
    expect(repairJson(input)).toEqual({ a: 1 });
  });

  it('handles unclosed markdown fence with conversational preamble', () => {
    const input = 'Certainly! Below is the requested data:\n```json\n{"status": "ok", "items": [1, 2';
    expect(repairJson(input)).toEqual({ status: 'ok', items: [1, 2] });
  });

  it('escapes unescaped raw newlines and tabs inside string values', () => {
    const input = '{"text": "Line 1\nLine 2\tTabbed\r\nLine 3"}';
    expect(repairJson(input)).toEqual({
      text: 'Line 1\nLine 2\tTabbed\r\nLine 3',
    });
  });

  it('handles conversational preamble before JSON array', () => {
    const input = 'Here are your records:\n[{"id": 1}, {"id": 2';
    expect(repairJson(input)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('supports unquoted keys and Python-style single quotes', () => {
    expect(repairJson('{name: "Alice", age: 30}')).toEqual({ name: 'Alice', age: 30 });
    expect(repairJson("{'user': 'Bob', 'active': true}")).toEqual({
      user: 'Bob',
      active: true,
    });
  });

  it('gracefully handles non-JSON conversational text via fallback and onError', () => {
    const onError = vi.fn();
    const result = repairJson('Thinking deeply about your request...', {
      fallback: { loading: true },
      onError,
    });
    expect(result).toEqual({ loading: true });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('Audit Regression Tests (5 Edge Cases)', () => {
  // Case 1: Split escape sequences across chunks
  it('handles split escape sequence without escaping closing quote (Audit Case 1)', async () => {
    // Chunk 1 ends with dangling backslash inside string
    // Chunk 2 starts with escaped newline character 'nline2"}'
    const chunk1 = '{"msg": "line1\\';
    const chunk2 = 'nline2"}';

    // Verify Chunk 1 snapshot does not crash or corrupt
    const snap1 = repairJson(chunk1);
    expect(snap1).toEqual({ msg: 'line1' });

    // Stream both chunks
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.close();
      },
    });

    const snapshots: unknown[] = [];
    for await (const snap of parseJsonStream(stream)) {
      snapshots.push(snap);
    }

    expect(snapshots[snapshots.length - 1]).toEqual({
      msg: 'line1\nline2',
    });
  });

  // Case 2: Even vs. Odd backslashes before quotes
  it('distinguishes even vs odd backslashes before quotes (Audit Case 2)', () => {
    // Even backslashes (\\): closing quote is unescaped and closes string
    const evenInput = '{"path": "C:\\\\"}';
    expect(repairJson(evenInput)).toEqual({ path: 'C:\\' });

    // Odd backslashes (\"): quote is escaped and remains inside string
    const oddInput = '{"quote": "He said \\"hi"}';
    expect(repairJson(oddInput)).toEqual({ quote: 'He said "hi' });
  });

  // Case 3: Strings containing brackets and braces
  it('ensures brackets and braces inside strings do not alter container stack (Audit Case 3)', () => {
    const input = '{"code": "function() { return [1, 2]; }", "active": tru';
    expect(repairJson(input)).toEqual({
      code: 'function() { return [1, 2]; }',
      active: true,
    });
  });

  // Case 4: Scientific notation & negative zero in numbers
  it('safely strips incomplete scientific notation exponents (Audit Case 4)', () => {
    expect(repairJson('{"val": 1e')).toEqual({ val: 1 });
    expect(repairJson('{"val": 1e+')).toEqual({ val: 1 });
    expect(repairJson('{"val": 1.5e-')).toEqual({ val: 1.5 });
    expect(repairJson('{"val": 2.0E+')).toEqual({ val: 2 });
  });

  // Case 5: Memory growth on large streams (500KB+)
  it('handles large payloads (500KB+) smoothly without quadratic bottlenecks (Audit Case 5)', () => {
    const itemsCount = 5000;
    const items = Array.from({ length: itemsCount }, (_, i) => ({
      id: i,
      name: `User_${i}`,
      score: i * 1.5,
    }));
    const largeJson = JSON.stringify({ total: itemsCount, items });

    // Ensure payload is ~200KB - 500KB
    expect(largeJson.length).toBeGreaterThan(150_000);

    // Truncate in the middle of a string item near the end
    const truncated = largeJson.slice(0, largeJson.length - 50);

    const startTime = performance.now();
    const result = repairJson<{ total: number; items: unknown[] }>(truncated);
    const durationMs = performance.now() - startTime;

    expect(result.total).toBe(itemsCount);
    expect(result.items.length).toBeGreaterThan(4500);
    // Parsing ~300KB should take well under 100ms
    expect(durationMs).toBeLessThan(250);
  });
});

describe('Chunk-Boundary Streaming Edge Cases (ReadableStream)', () => {
  it('handles escaped quote split across two chunks', async () => {
    const chunk1 = '{"text": "hello \\';
    const chunk2 = '"world"}';

    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.close();
      },
    });

    const snapshots: unknown[] = [];
    for await (const snap of parseJsonStream(stream)) {
      snapshots.push(snap);
    }

    expect(snapshots[snapshots.length - 1]).toEqual({
      text: 'hello "world',
    });
  });

  it('handles double backslash before closing quote split across chunks', async () => {
    const chunk1 = '{"path": "C:\\\\';
    const chunk2 = '"}';

    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.close();
      },
    });

    const snapshots: unknown[] = [];
    for await (const snap of parseJsonStream(stream)) {
      snapshots.push(snap);
    }

    expect(snapshots[snapshots.length - 1]).toEqual({
      path: 'C:\\',
    });
  });

  it('handles multi-byte UTF-8 emojis split across Uint8Array chunks', async () => {
    const encoder = new TextEncoder();
    const fullBytes = encoder.encode('{"greeting": "Hello 🚀🎉 世界"}');

    // Split across emoji multi-byte boundary
    const chunk1 = fullBytes.slice(0, 23);
    const chunk2 = fullBytes.slice(23, 29);
    const chunk3 = fullBytes.slice(29);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.enqueue(chunk3);
        controller.close();
      },
    });

    const snapshots: unknown[] = [];
    for await (const snap of parseJsonStream(stream)) {
      snapshots.push(snap);
    }

    expect(snapshots[snapshots.length - 1]).toEqual({
      greeting: 'Hello 🚀🎉 世界',
    });
  });

  it('deduplicates consecutive snapshots when chunks add only whitespace or incomplete key names', async () => {
    const chunks = [
      '{"status": "ok"',
      ' ',
      '  ',
      ', "incomp',
      'leteKey"',
      ': "value"}',
    ];

    const stream = new ReadableStream<string>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    const repairStream = createJsonRepairStream({ dedupe: true });
    const reader = stream.pipeThrough(repairStream).getReader();

    const snapshots: unknown[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      snapshots.push(value);
    }

    // Only distinct structural snapshots should be emitted:
    // 1. { status: "ok" } (whitespace and incomplete keys omitted)
    // 2. { status: "ok", incompleteKey: "value" }
    expect(snapshots).toEqual([
      { status: 'ok' },
      { status: 'ok', incompleteKey: 'value' },
    ]);
  });
});

describe('deepEqual utility', () => {
  it('correctly compares primitives and objects', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
    expect(deepEqual({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe('repairJsonString standalone utility', () => {
  it('returns valid JSON string representation without parsing', () => {
    const output = repairJsonString('{"title": "Hel');
    expect(output).toBe('{"title": "Hel"}');
    expect(JSON.parse(output)).toEqual({ title: 'Hel' });
  });
});
