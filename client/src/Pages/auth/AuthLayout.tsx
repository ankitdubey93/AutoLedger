import type { ReactNode } from 'react';
import { BookCheck, Boxes, ScanLine } from 'lucide-react';
import BrandMark from '../../components/BrandMark';
import FluidBackdrop from '../../components/ui/FluidBackdrop';

const HIGHLIGHTS = [
  {
    icon: BookCheck,
    title: 'Books that always balance',
    body: 'Double entry enforced by the database, an immutable ledger, and bank reconciliation that ties out to the cent.',
  },
  {
    icon: ScanLine,
    title: 'Bills that enter themselves',
    body: 'Drop in a supplier invoice — it is read, masked for personal data, coded to your chart and queued for review.',
  },
  {
    icon: Boxes,
    title: 'Inventory on the same ledger',
    body: 'Stock received on a bill and sold on an invoice posts to inventory and cost of sales automatically.',
  },
] as const;

/**
 * The frame around sign-in and sign-up: a product panel beside the form on
 * wide screens, collapsed to just the brand mark above the form on narrow
 * ones. Presentational only — the pages own their state.
 */
export default function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="min-h-screen grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <aside className="fluid-hero hidden lg:flex lg:min-h-screen flex-col justify-between gap-10 p-14 rounded-r-[2.5rem]">
        <FluidBackdrop waveHeight={170} />
        <BrandMark size="lg" inverse />
        <div className="flex flex-col gap-8 max-w-lg animate-[rise_800ms_var(--ease)_both]">
          <p className="display-figure m-0 text-[clamp(2.25rem,3.6vw,3.5rem)]">
            Accounting, bill capture and inventory — one ledger.
          </p>
          <ul className="m-0 p-0 list-none flex flex-col gap-5">
            {HIGHLIGHTS.map(({ icon: Icon, title: heading, body }) => (
              <li key={heading} className="flex gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--hero-plum)] text-white">
                  <Icon size={16} aria-hidden="true" />
                </span>
                <span>
                  <span className="block font-semibold">{heading}</span>
                  <span className="block text-sm mt-0.5">{body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="m-0 text-xs pb-8">© {new Date().getFullYear()} AutoLedger</p>
      </aside>

      <main className="flex flex-col justify-center px-4 py-12 sm:px-8 stagger">
        <div className="w-full max-w-[25rem] mx-auto flex flex-col gap-7">
          <div className="lg:hidden">
            <BrandMark size="lg" />
          </div>
          <header>
            <h1>{title}</h1>
            <p className="subtitle">{subtitle}</p>
          </header>
          {children}
        </div>
      </main>
    </div>
  );
}
