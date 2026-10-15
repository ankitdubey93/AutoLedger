import OrderListPage from './orders/OrderListPage';
import { SALES_ORDER_KIND } from './orders/orderKinds';

/** The sales order register (Phase 42) — see sales/orders/OrderListPage.tsx. */
export default function SalesOrdersPage() {
  return <OrderListPage config={SALES_ORDER_KIND} />;
}
