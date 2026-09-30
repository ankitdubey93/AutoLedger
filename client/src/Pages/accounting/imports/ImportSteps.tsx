export default function ImportSteps({ current }: { current: 1 | 2 | 3 | 4 }) {
  const labels = ['Upload', 'Map columns', 'Review & fix', 'Commit'];

  return (
    <ol aria-label="Import progress" className="flex flex-wrap gap-2 text-xs list-none p-0 m-0">
      {labels.map((label, index) => {
        const stepNumber = index + 1;
        const isCurrent = stepNumber === current;
        const isPast = stepNumber < current;

        return (
          <li
            key={stepNumber}
            {...(isCurrent ? { 'aria-current': 'step' } : {})}
            className={`flex items-center gap-1.5 ${
              isCurrent
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : isPast
                  ? 'text-[var(--text)]'
                  : 'text-[var(--muted)]'
            } rounded-full px-2 py-1`}
          >
            <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-medium ${
              isCurrent ? 'bg-[var(--accent)] text-white' : 'bg-current/20'
            }`}>
              {stepNumber}
            </span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}
