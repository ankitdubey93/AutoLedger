import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <main className="shell shell--narrow">
      <h1>Not found</h1>
      <p className="muted">
        That page does not exist. Most of AutoLedger is not built yet — see{' '}
        <code>docs/roadmap.md</code>.
      </p>
      <p>
        <Link to="/">Back to the dashboard</Link>
      </p>
    </main>
  );
}
