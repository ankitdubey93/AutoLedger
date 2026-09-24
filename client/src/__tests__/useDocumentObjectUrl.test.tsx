import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentObjectUrl } from '../utils/useDocumentObjectUrl';
import * as fetchServices from '../services/fetchServices';

/** useDocumentObjectUrl — a Document Vault file as a revocable blob: URL (Phase 30, Step 12). */

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let downloadSpy: ReturnType<typeof vi.spyOn>;
let counter: number;

function file(): { blob: Blob; filename: string } {
  return { blob: new Blob(['x'], { type: 'image/png' }), filename: 'logo.png' };
}

beforeEach(() => {
  counter = 0;
  // jsdom implements neither method, so both are stubbed onto URL directly.
  createObjectURL = vi.fn(() => `blob:mock-${String(++counter)}`);
  revokeObjectURL = vi.fn();
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
  downloadSpy = vi.spyOn(fetchServices, 'downloadDocument');
});

afterEach(() => {
  downloadSpy.mockRestore();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

describe('useDocumentObjectUrl', () => {
  it('returns null and never fetches for a null id', () => {
    const { result } = renderHook(() => useDocumentObjectUrl(null));
    expect(result.current).toBeNull();
    expect(downloadSpy).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('returns an object URL once the download succeeds', async () => {
    downloadSpy.mockResolvedValue(file());
    const { result } = renderHook(() => useDocumentObjectUrl('doc-1'));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe('blob:mock-1'));
    expect(downloadSpy).toHaveBeenCalledWith('doc-1');
  });

  it('returns null when the download fails', async () => {
    downloadSpy.mockRejectedValue(new Error('404'));
    const { result } = renderHook(() => useDocumentObjectUrl('doc-1'));
    await waitFor(() => expect(downloadSpy).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(result.current).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('revokes the URL on unmount', async () => {
    downloadSpy.mockResolvedValue(file());
    const { result, unmount } = renderHook(() => useDocumentObjectUrl('doc-1'));
    await waitFor(() => expect(result.current).toBe('blob:mock-1'));
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
  });

  it('revokes the old URL and fetches the new one when the id changes', async () => {
    downloadSpy.mockResolvedValue(file());
    const { result, rerender } = renderHook(({ id }) => useDocumentObjectUrl(id), {
      initialProps: { id: 'doc-1' as string | null },
    });
    await waitFor(() => expect(result.current).toBe('blob:mock-1'));
    rerender({ id: 'doc-2' });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
    // The previous id's URL is never returned for the new id.
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe('blob:mock-2'));
    rerender({ id: null });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-2');
    expect(result.current).toBeNull();
  });

  it('ignores a response that arrives after unmount — no URL created, nothing leaked', async () => {
    let resolveDownload: (value: { blob: Blob; filename: string }) => void = () => undefined;
    downloadSpy.mockReturnValue(
      new Promise((resolve) => {
        resolveDownload = resolve;
      }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { unmount } = renderHook(() => useDocumentObjectUrl('doc-1'));
    unmount();
    resolveDownload(file());
    await Promise.resolve();
    await Promise.resolve();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('ignores a stale response when the id changed while it was in flight', async () => {
    const resolvers: ((value: { blob: Blob; filename: string }) => void)[] = [];
    downloadSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { result, rerender } = renderHook(({ id }) => useDocumentObjectUrl(id), {
      initialProps: { id: 'doc-1' },
    });
    rerender({ id: 'doc-2' });
    resolvers[0]?.(file()); // the superseded doc-1 response lands late
    resolvers[1]?.(file());
    await waitFor(() => expect(result.current).toBe('blob:mock-1'));
    // Only doc-2's blob was ever turned into a URL.
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });
});
