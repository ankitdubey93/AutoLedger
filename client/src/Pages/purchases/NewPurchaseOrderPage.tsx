import OrderFormPage from '../sales/orders/OrderFormPage';
import { PURCHASE_ORDER_KIND } from '../sales/orders/orderKinds';

/** Draft or edit a purchase order (Phase 42) — see sales/orders/OrderFormPage.tsx. */
export default function NewPurchaseOrderPage() {
  return <OrderFormPage config={PURCHASE_ORDER_KIND} />;
}
