import OrderListPage from '../sales/orders/OrderListPage';
import { PURCHASE_ORDER_KIND } from '../sales/orders/orderKinds';

/** The purchase order register (Phase 42) — see sales/orders/OrderListPage.tsx. */
export default function PurchaseOrdersPage() {
  return <OrderListPage config={PURCHASE_ORDER_KIND} />;
}
