import OrderDetailPage from '../sales/orders/OrderDetailPage';
import { PURCHASE_ORDER_KIND } from '../sales/orders/orderKinds';

/** One purchase order (Phase 42) — see sales/orders/OrderDetailPage.tsx. */
export default function PurchaseOrderDetailPage() {
  return <OrderDetailPage config={PURCHASE_ORDER_KIND} />;
}
