import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import EmptyState from '../components/ui/EmptyState';

/**
 * Rendered for any URL no route matches. Inside the workspace it appears
 * beside the sidebar, so a mistyped path still leaves every page one click
 * away. Signed out, it renders full width.
 */
export default function NotFoundPage() {
  return (
    <section className="flex flex-col gap-4 max-w-xl mx-auto py-10 px-4">
      <h1 className="text-lg font-semibold m-0">Page not found</h1>
      <EmptyState
        icon={Compass}
        title="That page does not exist"
        body="It may have moved, or the link may be mistyped."
        action={<Link to="/">Back to the dashboard</Link>}
      />
    </section>
  );
}
