import OrderDetailPage from './orders/OrderDetailPage';
import { SALES_ORDER_KIND } from './orders/orderKinds';

/** One sales order (Phase 42) — see sales/orders/OrderDetailPage.tsx. */
export default function SalesOrderDetailPage() {
  return <OrderDetailPage config={SALES_ORDER_KIND} />;
}
