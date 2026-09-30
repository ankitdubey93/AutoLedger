import type { Account, Item } from '../../services/fetchServices';
import ProductFormDialog from './ProductFormDialog';

export { deriveItemCode } from './productCode';

/**
 * "Quick add" from an invoice or bill line: the same product form as
 * Products & Services, opened without leaving the document being drafted, and
 * the new product is then picked on the line. "Track inventory" works here
 * too — on an invoice the person can enter the stock they already hold so the
 * sale has something to issue; on a bill the bill itself brings the stock in.
 */
export default function QuickAddProductDialog({
  mode,
  accounts,
  defaultAccountId,
  onCreated,
  onCancel,
}: {
  /** `sale` on an invoice; `purchase` on a bill. */
  mode: 'sale' | 'purchase';
  /** Every account the dialog may offer — it filters by type itself. */
  accounts: Account[];
  /** The line's current account, prefilled as the revenue (sale) or expense (purchase) account. */
  defaultAccountId: string;
  onCreated: (item: Item) => void;
  onCancel: () => void;
}) {
  return (
    <ProductFormDialog
      accounts={accounts}
      context={mode}
      initialAccountId={defaultAccountId}
      onSaved={onCreated}
      onCancel={onCancel}
    />
  );
}
