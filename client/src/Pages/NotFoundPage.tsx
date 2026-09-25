import { Link } from 'react-router-dom';

/**
 * Rendered for any URL no route matches. Inside the workspace it appears
 * beside the sidebar, so a mistyped path still leaves every page one click
 * away. Signed out, it renders full width.
 */
export default function NotFoundPage() {
  return (
    <section className="shell shell--narrow">
      <h1>Not found</h1>
      <p className="muted">That page does not exist. It may have moved, or the link may be mistyped.</p>
      <p>
        <Link to="/">Back to the dashboard</Link>
      </p>
    </section>
  );
}
