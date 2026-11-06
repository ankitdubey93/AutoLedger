import { useEffect, useMemo, useState } from 'react';
import { getTaxCodes, type TaxCode } from '../services/fetchServices';
import { useLoadedLedgerSettings } from './LedgerSettingsContext';

// The catalogue is static, and a chart page has one hook per row, so one request serves them all.
let catalogue: Promise<TaxCode[]> | null = null;

function loadCatalogue(): Promise<TaxCode[]> {
  catalogue ??= getTaxCodes().catch((err: unknown) => {
    catalogue = null;
    throw err;
  });
  return catalogue;
}

export interface GstHelpers {
  isAustralian: boolean;
  /** The codes for this direction, in catalogue order. Empty until loaded or for a GENERIC organization. */
  codes: TaxCode[];
  /** What a line with no code will get from the server. */
  defaultCode: string;
  /** The rate behind a code; '' means the default. */
  rateOf: (code: string) => number;
}

/** Phase 49b — the GST catalogue for a document form. Asks the server only for an Australian organization. */
export function useGst(direction: 'SALES' | 'PURCHASES' | 'ANY'): GstHelpers {
  const settings = useLoadedLedgerSettings();
  const isAustralian = settings?.region === 'AU';
  const registered = settings?.gst?.registered ?? true;
  const [all, setAll] = useState<TaxCode[]>([]);

  useEffect(() => {
    if (!isAustralian) return;
    let ignore = false;
    loadCatalogue()
      .then((codes) => {
        if (!ignore) setAll(codes);
      })
      .catch(() => {
        // The picker stays empty and lines take the server's default.
      });
    return () => {
      ignore = true;
    };
  }, [isAustralian]);

  return useMemo(() => {
    const codes = all.filter((c) => (direction === 'ANY' || c.direction === direction) && (registered || !c.reported));
    const excluded = direction === 'SALES' ? 'S_EXCLUDED' : 'P_EXCLUDED';
    const taxable = direction === 'SALES' ? 'S_GST' : 'P_GST';
    const defaultCode = registered ? taxable : excluded;
    const rateOf = (code: string): number => {
      const found = all.find((c) => c.code === (code === '' ? defaultCode : code));
      return found?.rateBp ?? (registered && code === '' ? 1000 : 0);
    };
    return { isAustralian, codes, defaultCode, rateOf };
  }, [all, direction, registered, isAustralian]);
}
