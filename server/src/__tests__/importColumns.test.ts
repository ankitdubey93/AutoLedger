import { describe, expect, it } from 'vitest';
import { compactHeader, resolveColumnIndexes, findMissingRequired } from '../utils/importColumns.js';
import { ApiError } from '../utils/apiError.js';
import type { ImportColumnDef } from '../types/accounting.js';

/**
 * Unit tier — no database. Pure column-resolution logic for CSV import mapping.
 */

describe('compactHeader', () => {
  it('strips the asterisk, spaces and punctuation', () => {
    expect(compactHeader('*Contact Name')).toBe('contactname');
    expect(compactHeader('E-mail')).toBe('email');
  });
});

describe('resolveColumnIndexes', () => {
  const mockKindLabel = 'Customers';

  it('template header wins before synonyms', () => {
    const headers = ['Name', '*ContactName'];
    const columns: readonly ImportColumnDef[] = [
      {
        key: 'partyName',
        header: '*ContactName',
        label: 'Name',
        required: true,
        synonyms: ['name'],
        note: 'Customer name',
        example: 'Acme',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
    ];

    const result = resolveColumnIndexes(headers, columns, null, mockKindLabel);
    expect(result.partyName).toBe(1);
  });

  it('a header is claimed once', () => {
    const headers = ['Name'];
    const columns: readonly ImportColumnDef[] = [
      {
        key: 'partyName',
        header: '*ContactName',
        label: 'Name',
        required: true,
        synonyms: ['name'],
        note: 'Customer name',
        example: 'Acme',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'partyEmail',
        header: 'Email',
        label: 'Email',
        required: false,
        synonyms: ['name'],
        note: 'Email',
        example: 'a@x.test',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
    ];

    const result = resolveColumnIndexes(headers, columns, null, mockKindLabel);
    expect(result.partyName).toBe(0); // First column wins
    expect(result.partyEmail).toBe(null); // Second gets null
  });

  it('explicit map overrides automatic', () => {
    const headers = ['Customer Title', 'Mail'];
    const columns: readonly ImportColumnDef[] = [
      {
        key: 'partyName',
        header: '*ContactName',
        label: 'Name',
        required: true,
        synonyms: ['name'],
        note: 'Customer name',
        example: 'Acme',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'partyEmail',
        header: 'EmailAddress',
        label: 'Email',
        required: false,
        synonyms: ['email'],
        note: 'Email',
        example: 'a@x.test',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
    ];
    const columnMap = { partyName: 'Customer Title', partyEmail: 'Mail' };

    const result = resolveColumnIndexes(headers, columns, columnMap, mockKindLabel);
    expect(result.partyName).toBe(0);
    expect(result.partyEmail).toBe(1);
  });

  it('explicit null un-maps', () => {
    const headers = ['Name', 'Email'];
    const columns: readonly ImportColumnDef[] = [
      {
        key: 'partyName',
        header: '*ContactName',
        label: 'Name',
        required: true,
        synonyms: ['name'],
        note: 'Customer name',
        example: 'Acme',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'partyEmail',
        header: 'EmailAddress',
        label: 'Email',
        required: false,
        synonyms: ['email'],
        note: 'Email',
        example: 'a@x.test',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
    ];
    const columnMap = { partyName: null };

    const result = resolveColumnIndexes(headers, columns, columnMap, mockKindLabel);
    expect(result.partyName).toBe(null);
    expect(result.partyEmail).toBe(1); // Email is auto-matched
  });

  it('column map: unknown key is 400', () => {
    const headers = ['Name'];
    const columns: readonly ImportColumnDef[] = [
      {
        key: 'partyName',
        header: '*ContactName',
        label: 'Name',
        required: true,
        synonyms: ['name'],
        note: 'Customer name',
        example: 'Acme',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
    ];
    const columnMap = { bogus: 'Name' };

    expect(() => resolveColumnIndexes(headers, columns, columnMap, mockKindLabel)).toThrow(ApiError);
    try {
      resolveColumnIndexes(headers, columns, columnMap, mockKindLabel);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toBe('Unknown column "bogus" for a Customers import');
    }
  });

  it('column map: a header not in the file is 400', () => {
    const headers = ['Name'];
    const columns: readonly ImportColumnDef[] = [
      {
        key: 'partyName',
        header: '*ContactName',
        label: 'Name',
        required: true,
        synonyms: ['name'],
        note: 'Customer name',
        example: 'Acme',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
    ];
    const columnMap = { partyName: 'Nope' };

    expect(() => resolveColumnIndexes(headers, columns, columnMap, mockKindLabel)).toThrow(ApiError);
    try {
      resolveColumnIndexes(headers, columns, columnMap, mockKindLabel);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toBe('The file has no column named "Nope"');
    }
  });

  it('column map: one header mapped twice is 400', () => {
    const headers = ['Name'];
    const columns: readonly ImportColumnDef[] = [
      {
        key: 'partyName',
        header: '*ContactName',
        label: 'Name',
        required: true,
        synonyms: ['name'],
        note: 'Customer name',
        example: 'Acme',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'partyEmail',
        header: 'EmailAddress',
        label: 'Email',
        required: false,
        synonyms: ['email'],
        note: 'Email',
        example: 'a@x.test',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
    ];
    const columnMap = { partyName: 'Name', partyEmail: 'Name' };

    expect(() => resolveColumnIndexes(headers, columns, columnMap, mockKindLabel)).toThrow(ApiError);
    try {
      resolveColumnIndexes(headers, columns, columnMap, mockKindLabel);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toBe('Column "Name" is mapped to more than one field');
    }
  });
});

describe('findMissingRequired', () => {
  it('reports required columns before one-of sets', () => {
    const columns: readonly ImportColumnDef[] = [
      {
        key: 'code',
        header: '*Code',
        label: 'Code',
        required: true,
        synonyms: [],
        note: 'Account code',
        example: '1000',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'debit',
        header: 'Debit',
        label: 'Debit',
        required: false,
        synonyms: [],
        note: 'Debit amount',
        example: '100',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'credit',
        header: 'Credit',
        label: 'Credit',
        required: false,
        synonyms: [],
        note: 'Credit amount',
        example: '50',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'amount',
        header: 'Amount',
        label: 'Signed amount',
        required: false,
        synonyms: [],
        note: 'Amount',
        example: '100',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
    ];
    const resolved = {
      code: null,
      debit: null,
      credit: null,
      amount: null,
    };
    const requiredOneOf = [['debit', 'credit'], ['amount']];

    const result = findMissingRequired(columns, requiredOneOf, resolved);
    expect(result).toEqual(['code', 'debit', 'credit']);
  });

  it('a satisfied one-of set reports nothing', () => {
    const columns: readonly ImportColumnDef[] = [
      {
        key: 'code',
        header: '*Code',
        label: 'Code',
        required: true,
        synonyms: [],
        note: 'Account code',
        example: '1000',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'debit',
        header: 'Debit',
        label: 'Debit',
        required: false,
        synonyms: [],
        note: 'Debit amount',
        example: '100',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'credit',
        header: 'Credit',
        label: 'Credit',
        required: false,
        synonyms: [],
        note: 'Credit amount',
        example: '50',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'amount',
        header: 'Amount',
        label: 'Signed amount',
        required: false,
        synonyms: [],
        note: 'Amount',
        example: '100',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
    ];
    const resolved = {
      code: 0,
      debit: 1,
      credit: 2,
      amount: null,
    };
    const requiredOneOf = [['debit', 'credit'], ['amount']];

    const result = findMissingRequired(columns, requiredOneOf, resolved);
    expect(result).toEqual([]);
  });

  it('reports the first unsatisfied one-of set', () => {
    const columns: readonly ImportColumnDef[] = [
      {
        key: 'debit',
        header: 'Debit',
        label: 'Debit',
        required: false,
        synonyms: [],
        note: 'Debit amount',
        example: '100',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'credit',
        header: 'Credit',
        label: 'Credit',
        required: false,
        synonyms: [],
        note: 'Credit amount',
        example: '50',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'amount',
        header: 'Amount',
        label: 'Signed amount',
        required: false,
        synonyms: [],
        note: 'Amount',
        example: '100',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
    ];
    const resolved = {
      debit: null,
      credit: null,
      amount: null,
    };
    const requiredOneOf = [['debit', 'credit'], ['amount']];

    const result = findMissingRequired(columns, requiredOneOf, resolved);
    // Should report the first unsatisfied set: debit and credit
    expect(result).toContain('debit');
    expect(result).toContain('credit');
  });
});
