import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  anthropicModelClient,
  geminiModelClient,
  geminiThinkingConfig,
  normalizeAnthropicUsage,
  normalizeGeminiUsage,
  resolveModelClient,
} from '../../services/capture/modelClient.js';
import type { MessagesClient } from '../../services/capture/modelClient.js';
import { extractFromPages } from '../../services/capture/extractionService.js';

/**
 * Capture's multi-provider seam (Phase 19). Anthropic cases stub the
 * MessagesClient interface directly (same pattern extraction.test.ts
 * already uses); Gemini cases inject a fake `fetchImpl` so no case in this
 * file reaches the network. `fetch` is stubbed to throw across the whole
 * file as a structural proof, matching extraction.test.ts's convention.
 */

const GEMINI_SCHEMA = { type: 'OBJECT', properties: {} } as const;

function fakePng(): Buffer {
  return Buffer.from('fake-png');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('modelClient (Phase 19)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('no network in tests');
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('geminiModelClient sends redacted PNGs as inline_data and the schema as responseSchema', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Promise.resolve(
        jsonResponse({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }),
      );
    }) as unknown as typeof fetch;

    const client = geminiModelClient({ apiKey: 'test-key', model: 'gemini-3.6-flash', fetchImpl });
    const png = fakePng();
    await client.generateStructured({
      images: [png],
      prompt: 'extract it',
      schema: { name: 'record_invoice', description: 'd', jsonSchema: {}, geminiSchema: GEMINI_SCHEMA },
      maxTokens: 100,
      timeoutMs: 1000,
    });

    expect(capturedUrl).toContain('/models/gemini-3.6-flash:generateContent');
    expect((capturedInit?.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
    const body = JSON.parse(capturedInit?.body as string) as {
      contents: { parts: { inline_data?: { mime_type: string; data: string }; text?: string }[] }[];
      generationConfig: { responseMimeType: string; responseSchema: unknown; thinkingConfig: unknown };
    };
    expect(body.contents[0]?.parts[0]?.inline_data).toEqual({
      mime_type: 'image/png',
      data: png.toString('base64'),
    });
    expect(body.contents[0]?.parts[1]?.text).toBe('extract it');
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toEqual(GEMINI_SCHEMA);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
  });

  it('geminiModelClient sends thinkingBudget when configured with a 2.5 model', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(
        jsonResponse({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }),
      );
    }) as unknown as typeof fetch;

    const client = geminiModelClient({ apiKey: 'k', model: 'gemini-2.5-flash', fetchImpl });
    await client.generateStructured({
      images: [],
      prompt: 'x',
      schema: { name: 'n', description: 'd', jsonSchema: {}, geminiSchema: GEMINI_SCHEMA },
      maxTokens: 1,
      timeoutMs: 1000,
    });

    const body = JSON.parse(capturedInit?.body as string) as {
      generationConfig: { thinkingConfig: unknown };
    };
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('geminiThinkingConfig uses thinkingBudget for the 2.5 family', () => {
    expect(geminiThinkingConfig('gemini-2.5-flash')).toEqual({ thinkingBudget: 0 });
  });

  it('geminiThinkingConfig uses thinkingLevel for 3.x and anything newer', () => {
    expect(geminiThinkingConfig('gemini-3.6-flash')).toEqual({ thinkingLevel: 'low' });
    expect(geminiThinkingConfig('gemini-3.1-flash-lite')).toEqual({ thinkingLevel: 'low' });
    expect(geminiThinkingConfig('gemini-flash-latest')).toEqual({ thinkingLevel: 'low' });
  });

  it('geminiModelClient parses the JSON text part', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] })),
    ) as unknown as typeof fetch;
    const client = geminiModelClient({ apiKey: 'k', model: 'm', fetchImpl });

    const result = await client.generateStructured({
      images: [],
      prompt: 'x',
      schema: { name: 'n', description: 'd', jsonSchema: {}, geminiSchema: GEMINI_SCHEMA },
      maxTokens: 1,
      timeoutMs: 1000,
    });

    expect(result.value).toEqual({ a: 1 });
  });

  it('geminiModelClient returns null when there are no candidates', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({}))) as unknown as typeof fetch;
    const client = geminiModelClient({ apiKey: 'k', model: 'm', fetchImpl });

    const result = await client.generateStructured({
      images: [],
      prompt: 'x',
      schema: { name: 'n', description: 'd', jsonSchema: {}, geminiSchema: GEMINI_SCHEMA },
      maxTokens: 1,
      timeoutMs: 1000,
    });

    expect(result.value).toBeNull();
  });

  it('geminiModelClient returns null for non-JSON text', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] })),
    ) as unknown as typeof fetch;
    const client = geminiModelClient({ apiKey: 'k', model: 'm', fetchImpl });

    const result = await client.generateStructured({
      images: [],
      prompt: 'x',
      schema: { name: 'n', description: 'd', jsonSchema: {}, geminiSchema: GEMINI_SCHEMA },
      maxTokens: 1,
      timeoutMs: 1000,
    });

    expect(result.value).toBeNull();
  });

  it('geminiModelClient throws 502 without echoing the response body', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ error: 'SECRET-ECHO' }, 429)),
    ) as unknown as typeof fetch;
    const client = geminiModelClient({ apiKey: 'k', model: 'm', fetchImpl });

    await expect(
      client.generateStructured({
        images: [],
        prompt: 'x',
        schema: { name: 'n', description: 'd', jsonSchema: {}, geminiSchema: GEMINI_SCHEMA },
        maxTokens: 1,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ status: 502, message: 'Gemini request failed with status 429' });

    try {
      await client.generateStructured({
        images: [],
        prompt: 'x',
        schema: { name: 'n', description: 'd', jsonSchema: {}, geminiSchema: GEMINI_SCHEMA },
        maxTokens: 1,
        timeoutMs: 1000,
      });
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET-ECHO');
    }
  });

  it('geminiModelClient appends the error status enum without echoing its message', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ error: { status: 'NOT_FOUND', message: 'SECRET-ECHO' } }, 404),
      ),
    ) as unknown as typeof fetch;
    const client = geminiModelClient({ apiKey: 'k', model: 'm', fetchImpl });

    await expect(
      client.generateStructured({
        images: [],
        prompt: 'x',
        schema: { name: 'n', description: 'd', jsonSchema: {}, geminiSchema: GEMINI_SCHEMA },
        maxTokens: 1,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      status: 502,
      message: 'Gemini request failed with status 404 (NOT_FOUND)',
    });

    try {
      await client.generateStructured({
        images: [],
        prompt: 'x',
        schema: { name: 'n', description: 'd', jsonSchema: {}, geminiSchema: GEMINI_SCHEMA },
        maxTokens: 1,
        timeoutMs: 1000,
      });
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET-ECHO');
    }
  });

  it('anthropicModelClient returns the tool_use input', async () => {
    const stub: MessagesClient = {
      messages: {
        create: () => Promise.resolve({ content: [{ type: 'tool_use', input: { x: 1 } }] }),
      },
    };
    const client = anthropicModelClient('extract', stub);

    const result = await client.generateStructured({
      images: [],
      prompt: 'x',
      schema: { name: 'record_invoice', description: 'd', jsonSchema: {}, geminiSchema: GEMINI_SCHEMA },
      maxTokens: 1,
      timeoutMs: 1000,
    });

    expect(result.value).toEqual({ x: 1 });
  });

  it('geminiModelClient reports usageMetadata as normalized usage', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          candidates: [{ content: { parts: [{ text: '{}' }] } }],
          usageMetadata: {
            promptTokenCount: 1000,
            candidatesTokenCount: 200,
            thoughtsTokenCount: 50,
            totalTokenCount: 1250,
          },
        }),
      ),
    ) as unknown as typeof fetch;
    const client = geminiModelClient({ apiKey: 'k', model: 'm', fetchImpl });

    const result = await client.generateStructured({
      images: [],
      prompt: 'x',
      schema: { name: 'n', description: 'd', jsonSchema: {}, geminiSchema: GEMINI_SCHEMA },
      maxTokens: 1,
      timeoutMs: 1000,
    });

    // thoughtsTokenCount is folded INTO outputTokens (Gemini bills it as
    // output) and reported separately as reasoningTokens.
    expect(result.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 250,
      cachedInputTokens: 0,
      reasoningTokens: 50,
      totalTokens: 1250,
    });
  });

  it('geminiModelClient reports null usage when usageMetadata is absent', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ candidates: [{ content: { parts: [{ text: '{}' }] } }] })),
    ) as unknown as typeof fetch;
    const client = geminiModelClient({ apiKey: 'k', model: 'm', fetchImpl });

    const result = await client.generateStructured({
      images: [],
      prompt: 'x',
      schema: { name: 'n', description: 'd', jsonSchema: {}, geminiSchema: GEMINI_SCHEMA },
      maxTokens: 1,
      timeoutMs: 1000,
    });

    expect(result.usage).toBeNull();
  });

  it('geminiModelClient still reports usage when there are no candidates', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ usageMetadata: { promptTokenCount: 10 } })),
    ) as unknown as typeof fetch;
    const client = geminiModelClient({ apiKey: 'k', model: 'm', fetchImpl });

    const result = await client.generateStructured({
      images: [],
      prompt: 'x',
      schema: { name: 'n', description: 'd', jsonSchema: {}, geminiSchema: GEMINI_SCHEMA },
      maxTokens: 1,
      timeoutMs: 1000,
    });

    expect(result.value).toBeNull();
    expect(result.usage?.inputTokens).toBe(10);
  });

  it('anthropicModelClient reports usage from the response', async () => {
    const stub: MessagesClient = {
      messages: {
        create: () =>
          Promise.resolve({
            content: [{ type: 'tool_use', input: { x: 1 } }],
            usage: {
              input_tokens: 800,
              output_tokens: 120,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          }),
      },
    };
    const client = anthropicModelClient('extract', stub);

    const result = await client.generateStructured({
      images: [],
      prompt: 'x',
      schema: { name: 'record_invoice', description: 'd', jsonSchema: {}, geminiSchema: GEMINI_SCHEMA },
      maxTokens: 1,
      timeoutMs: 1000,
    });

    expect(result.usage).toEqual({
      inputTokens: 800,
      outputTokens: 120,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 920,
    });
  });

  it('anthropicModelClient counts a cache write as input', async () => {
    const stub: MessagesClient = {
      messages: {
        create: () =>
          Promise.resolve({
            content: [{ type: 'tool_use', input: { x: 1 } }],
            usage: {
              input_tokens: 800,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 40,
            },
          }),
      },
    };
    const client = anthropicModelClient('extract', stub);

    const result = await client.generateStructured({
      images: [],
      prompt: 'x',
      schema: { name: 'record_invoice', description: 'd', jsonSchema: {}, geminiSchema: GEMINI_SCHEMA },
      maxTokens: 1,
      timeoutMs: 1000,
    });

    expect(result.usage?.inputTokens).toBe(840);
  });

  it('anthropicModelClient reports null usage when the response carries none', async () => {
    const stub: MessagesClient = {
      messages: {
        create: () => Promise.resolve({ content: [{ type: 'tool_use', input: { x: 1 } }] }),
      },
    };
    const client = anthropicModelClient('extract', stub);

    const result = await client.generateStructured({
      images: [],
      prompt: 'x',
      schema: { name: 'record_invoice', description: 'd', jsonSchema: {}, geminiSchema: GEMINI_SCHEMA },
      maxTokens: 1,
      timeoutMs: 1000,
    });

    expect(result.usage).toBeNull();
  });

  it('normalizeAnthropicUsage returns null for a response with no usage block', () => {
    expect(normalizeAnthropicUsage({ content: [] })).toBeNull();
  });

  it('normalizeGeminiUsage returns null for a response with no usageMetadata', () => {
    expect(normalizeGeminiUsage({ candidates: [] })).toBeNull();
  });

  it('resolveModelClient throws 503 for gemini with no key', () => {
    expect(() =>
      resolveModelClient('extract', {
        provider: 'gemini',
        anthropicApiKey: 'k',
        geminiApiKey: '',
        geminiModel: 'm',
      }),
    ).toThrowError(/GEMINI_API_KEY/);
  });

  it('resolveModelClient returns a gemini client reporting its model', () => {
    const client = resolveModelClient('extract', {
      provider: 'gemini',
      anthropicApiKey: '',
      geminiApiKey: 'k',
      geminiModel: 'm',
    });
    expect(client.provider).toBe('gemini');
    expect(client.model).toBe('m');
  });

  it.skipIf(process.env.CAPTURE_GEMINI_E2E !== '1')(
    'live Gemini extraction of a generated invoice image',
    async () => {
      // The suite-wide beforeEach stubs globalThis.fetch to throw for every
      // case in this file, including this one — this is the ONE case that
      // must reach the real network, so restore the real fetch first.
      fetchSpy.mockRestore();

      const png = await sharp({
        create: { width: 400, height: 200, channels: 3, background: { r: 255, g: 255, b: 255 } },
      })
        .composite([
          {
            input: Buffer.from(
              `<svg width="400" height="200"><text x="20" y="40" font-size="20">ACME SUPPLIES</text><text x="20" y="80" font-size="18">Invoice INV-77</text><text x="20" y="120" font-size="18">Total 120.00</text></svg>`,
            ),
            top: 0,
            left: 0,
          },
        ])
        .png()
        .toBuffer();

      const client = resolveModelClient('extract', {
        provider: 'gemini',
        anthropicApiKey: '',
        geminiApiKey: process.env.GEMINI_API_KEY ?? '',
        geminiModel: process.env.CAPTURE_GEMINI_MODEL ?? 'gemini-3.6-flash',
      });

      const result = await extractFromPages([png], undefined, client);
      expect(result.totalCents).toBe(12000);
    },
  );
});
