import { useEffect, useState } from 'react';
import {
  fetchStockLocations,
  fetchStockProductBalances,
  fetchStockSettings,
  type StockLocation,
  type StockProductBalance,
} from '../../services/fetchServices';

/**
 * What an invoice/bill line needs to show an INVENTORY product (Phase 32): its
 * on-hand quantity, the StockLedger locations a line can move stock at, and the
 * default location. Everything comes from StockLedger's own API through
 * fetchServices — no import of any StockLedger page or module.
 *
 * Best effort: an org that has never opened StockLedger has no locations and no
 * stock products, and a failed call must not stop the document form from
 * working, so every failure just leaves the empty defaults.
 */
export interface StockLineData {
  balances: Map<string, StockProductBalance>;
  locations: StockLocation[];
  defaultLocationId: string | null;
}

const EMPTY: StockLineData = { balances: new Map(), locations: [], defaultLocationId: null };

export function useStockLineData(): StockLineData {
  const [data, setData] = useState<StockLineData>(EMPTY);

  useEffect(() => {
    let ignore = false;
    Promise.all([fetchStockProductBalances(), fetchStockLocations(false), fetchStockSettings()])
      .then(([balancesRes, locationsRes, settingsRes]) => {
        if (ignore) return;
        setData({
          balances: new Map(balancesRes.balances.map((b) => [b.ledgerItemId, b])),
          locations: locationsRes.locations,
          defaultLocationId: settingsRes.settings.defaultLocationId,
        });
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, []);

  return data;
}
