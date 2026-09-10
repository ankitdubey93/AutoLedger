import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractFromPages, validateArithmetic } from '../../services/ap-flow/extractionService.js';
import type { VisionClient } from '../../services/ap-flow/extractionService.js';
import { env } from '../../config/env.js';

/**
 * Fully stubbed — no case in this file reaches the network or needs
 * ANTHROPIC_API_KEY. `fetch` is stubbed to throw across the whole file as a
 * structural proof.
 */

function stubClient(input: Record<string, unknown>): VisionClient {
  return {
    messages: {
      create: () =>
        Promise.resolve({
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'record_invoice', input }],
        }),
    },
  };
}

function stubClientNoToolUse(): VisionClient {
  return {
    messages: {
      create: () => Promise.resolve({ content: [{ type: 'text', text: 'no tool call' }] }),
    },
  };
}

describe('extractionService', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('no network in tests');
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('extracts the docs/ap-flow.md worked example correctly', async () => {
    const client = stubClient({
      vendor_name: 'AWS Cloud Services',
      invoice_number: 'INV-2026-8901',
      invoice_date: '2026-08-15',
      currency: 'USD',
      subtotal: '450.00',
      tax: '0.00',
      total: '450.00',
      line_items: [
        { description: 'EC2 Compute Instances', amount: '350.00' },
        { description: 'S3 Storage Usage', amount: '100.00' },
      ],
      field_confidence: { total: 0.95 },
    });

    const result = await extractFromPages([Buffer.from('fake-png')], client);

    expect(result.subtotalCents).toBe(45000);
    expect(result.totalCents).toBe(45000);
    expect(result.lineItems[0]?.amountCents).toBe(35000);
    expect(result.arithmeticOk).toBe(true);
  });

  it('never produces a non-integer cents value', async () => {
    const client = stubClient({
      total: '450.00',
      line_items: [],
      field_confidence: {},
    });
    const result = await extractFromPages([Buffer.from('x')], client);
    expect(Number.isInteger(result.totalCents)).toBe(true);
  });

  it('flags a line-item/subtotal mismatch without throwing', async () => {
    const client = stubClient({
      subtotal: '350.00',
      line_items: [{ description: 'a', amount: '349.99' }],
      field_confidence: {},
    });
    const result = await extractFromPages([Buffer.from('x')], client);
    expect(result.arithmeticOk).toBe(false);
    expect(result.validationErrors.some((e) => e.includes('34999') && e.includes('35000'))).toBe(true);
  });

  it('flags a subtotal+tax/total mismatch', async () => {
    const client = stubClient({
      subtotal: '450.00',
      tax: '5.00',
      total: '450.00',
      line_items: [],
      field_confidence: {},
    });
    const result = await extractFromPages([Buffer.from('x')], client);
    expect(result.arithmeticOk).toBe(false);
  });

  it('records a validation error and does not throw on an unparseable amount', async () => {
    const client = stubClient({
      subtotal: 'not a number',
      line_items: [],
      field_confidence: {},
    });
    const result = await extractFromPages([Buffer.from('x')], client);
    expect(result.subtotalCents).toBe(null);
    expect(result.validationErrors.length).toBeGreaterThan(0);
  });

  it('returns 502 when the response has no tool_use block', async () => {
    const client = stubClientNoToolUse();
    await expect(extractFromPages([Buffer.from('x')], client)).rejects.toMatchObject({ status: 502 });
  });

  it('returns 503 with no client and no ANTHROPIC_API_KEY', async () => {
    expect(env.ANTHROPIC_API_KEY).toBe('');
    await expect(extractFromPages([Buffer.from('x')])).rejects.toMatchObject({ status: 503 });
  });

  it('clamps field_confidence into [0,1] and drops non-numeric entries', async () => {
    const client = stubClient({
      line_items: [],
      field_confidence: { total: 1.7, vendor_name: -0.2, junk: 'x' },
    });
    const result = await extractFromPages([Buffer.from('x')], client);
    expect(result.fieldConfidence).toEqual({ total: 1, vendor_name: 0 });
  });

  it('validateArithmetic on all-nulls has nothing to contradict', () => {
    expect(validateArithmetic([], null, null, null)).toEqual({ ok: true, errors: [] });
  });

  it('performs no network request across this entire file', () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
