import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Inbox } from 'lucide-react';
import { listApFlowReviewQueue } from '../../services/fetchServices';

/**
 * The bill inbox on the dashboard: how many captured bills are waiting for a
 * person to check them. It reads the review queue's total and nothing else,
 * so it costs one small request. On failure it renders nothing: the
 * dashboard is still useful without it.
 */
export default function InboxSummaryCard() {
  const [waiting, setWaiting] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listApFlowReviewQueue({ limit: 1 }, controller.signal)
      .then((res) => {
        if (typeof res.totalCount === 'number') setWaiting(res.totalCount);
      })
      .catch(() => {
        // Optional panel; see the comment above.
      });
    return () => controller.abort();
  }, []);

  if (waiting === null) return null;

  return (
    <section aria-label="Bill inbox" className="card flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 items-center justify-center rounded-md bg-[var(--accent-soft)] text-[var(--accent)]"
        >
          <Inbox size={17} />
        </span>
        <div>
          <h2 className="text-base font-semibold m-0">Bill inbox</h2>
          <p className="muted m-0">
            {waiting === 0
              ? 'Nothing waiting for review. Upload a bill or receipt and it is read for you.'
              : `${String(waiting)} captured ${waiting === 1 ? 'bill is' : 'bills are'} waiting for review.`}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 text-sm">
        {waiting > 0 && <Link to="/inbox/review">Review</Link>}
        <Link to="/inbox">Upload a bill</Link>
      </div>
    </section>
  );
}
