import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { INVENTORY_BASE } from '../../routes/paths';
import { lookupStockById } from '../../services/fetchServices';

/**
 * Resolves a scanned QR label's `/scan/<kind>/<id>` URL to a real page.
 * `item` and `location` resolve without a network round trip (the id
 * already names the destination); `lot` and `serial` carry only their own
 * id, so they resolve through the by-id lookup (Step 30's
 * `lookupStockById`) to find the item that owns them.
 */
export default function InventoryScanRedirect() {
  const { kind, id } = useParams<{ kind: string; id: string }>();
  const base = INVENTORY_BASE;
  const [target, setTarget] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (kind === undefined || id === undefined) return;

    if (kind === 'item') {
      setTarget(`${base}/items/${id}`);
      return;
    }
    if (kind === 'location') {
      setTarget(`${base}/locations?focus=${id}`);
      return;
    }
    if (kind === 'lot' || kind === 'serial') {
      lookupStockById(kind, id)
        .then((res) => setTarget(`${base}/items/${res.match.itemId}`))
        .catch(() => setNotFound(true));
      return;
    }
    setTarget(`${base}/lookup`);
  }, [kind, id, base]);

  if (notFound) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-[var(--text)]">This label belongs to nothing in your organization.</p>
        <Link to={`${base}/lookup`} className="text-sm text-[var(--accent)]">
          Back to lookup
        </Link>
      </div>
    );
  }

  if (target !== null) return <Navigate to={target} replace />;

  return <p>Resolving…</p>;
}
