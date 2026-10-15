import OrderFormPage from './orders/OrderFormPage';
import { SALES_ORDER_KIND } from './orders/orderKinds';

/** Draft or edit a sales order (Phase 42) — see sales/orders/OrderFormPage.tsx. */
export default function NewSalesOrderPage() {
  return <OrderFormPage config={SALES_ORDER_KIND} />;
}
