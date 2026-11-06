import { useCallback, useEffect, useState } from 'react';
import { ScrollText } from 'lucide-react';
import {
  getTpar,
  listVendors,
  lodgeTpar,
  setVendorTparReportable,
  type TparReport,
  type Vendor,
} from '../../services/fetchServices';
import { useCan } from '../../context/AuthContext';
import { formatDate, orgToday } from '../../utils/date';
import { formatCents } from '../../utils/money';
import ConfirmDialog from '../../components/ConfirmDialog';
import ExportMenu from '../../components/ui/ExportMenu';
import LoadingState from '../../components/ui/LoadingState';
import PageHeader from '../../components/ui/PageHeader';
import { inputClass, primaryButtonClass } from '../../components/ui/formClasses';

/** The financial year that has most recently ended: on 1 October 2026 that is the year ending June 2026. */
export function lastCompletedFinancialYear(today: string): number {
  const year = Number(today.slice(0, 4));
  return Number(today.slice(5, 7)) >= 7 ? year : year - 1;
}

/** Phase 49h — the taxable payments annual report. */
export default function TparPage() {
  const can = useCan();
  const [year, setYear] = useState(lastCompletedFinancialYear(orgToday()));
  const [report, setReport] = useState<TparReport | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lodgedOn, setLodgedOn] = useState(orgToday());
  const [reference, setReference] = useState('');
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    const [reportRes, vendorRes] = await Promise.all([getTpar(year), listVendors()]);
    setReport(reportRes.report);
    setVendors(vendorRes.vendors.filter((v) => v.isActive));
  }, [year]);

  useEffect(() => {
    let ignore = false;
    setReport(null);
    load().catch((err: unknown) => {
      if (!ignore) setError(err instanceof Error ? err.message : 'Could not load this report');
    });
    return () => {
      ignore = true;
    };
  }, [load]);

  async function toggle(vendor: Vendor) {
    setError(null);
    try {
      await setVendorTparReportable(vendor.id, vendor.tparReportable !== true);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not change this contractor');
    }
  }

  async function lodge() {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      setReport((await lodgeTpar(year, { lodgedOn, atoReference: reference.trim() === '' ? null : reference.trim() })).report);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not record this');
    } finally {
      setBusy(false);
    }
  }

  const incomplete = report?.rows.some((r) => r.problems.length > 0) ?? false;

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        as="h2"
        icon={ScrollText}
        title="Taxable payments annual report"
        subtitle="For businesses paying contractors for building, cleaning, courier or road freight, IT, or security services."
        actions={report === null ? undefined : <ExportMenu path={`/tpar/${String(year)}`} params={{}} />}
      />

      <p className="text-sm text-[var(--muted)] m-0">
        AutoLedger prepares this report. It doesn't lodge it with the ATO. Every bill from a flagged contractor counts, so
        check any that were only for materials, which may not be reportable.
      </p>

      {error !== null && <p className="status status--bad">{error}</p>}

      <label className="flex flex-col gap-1 text-sm max-w-xs">
        <span className="text-[var(--muted)]">Financial year ending June</span>
        <input type="number" value={year} min={2001} max={2100} onChange={(e) => setYear(Number(e.target.value))} className={inputClass} />
      </label>

      {report === null && error === null && <LoadingState />}

      {report !== null && (
        <>
          <p className="text-sm m-0">
            {formatDate(report.from)} to {formatDate(report.to)}, due {formatDate(report.dueDate)}
          </p>
          {report.uncodedLineCount > 0 && (
            <p className="status status--warn m-0">
              {report.uncodedLineCount} line(s) have no GST code and are left out. They were posted before this organization became Australian.
            </p>
          )}
          {report.rows.length === 0 ? (
            <p className="text-sm text-[var(--muted)] m-0">No payments to flagged contractors in this year.</p>
          ) : (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
              <table className="w-full border-collapse text-sm min-w-[40rem]">
                <thead>
                  <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                    <th className="p-3 font-medium">Contractor</th>
                    <th className="p-3 font-medium">ABN</th>
                    <th className="p-3 font-medium text-right">Gross paid</th>
                    <th className="p-3 font-medium text-right">GST</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.vendorId} className="border-t border-[var(--border)]">
                      <td className="p-3">
                        {r.name}
                        {r.problems.length > 0 && <span className="block text-xs text-[var(--bad)]">{r.problems.join(', ')}</span>}
                      </td>
                      <td className="p-3">{r.abn ?? '—'}</td>
                      <td className="p-3 text-right tabular-nums">{formatCents(r.grossPaidCents)}</td>
                      <td className="p-3 text-right tabular-nums">{formatCents(r.gstCents)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-[var(--border-strong)] font-medium">
                    <td className="p-3" colSpan={2}>
                      Total
                    </td>
                    <td className="p-3 text-right tabular-nums">{formatCents(report.totalGrossCents)}</td>
                    <td className="p-3 text-right tabular-nums">{formatCents(report.totalGstCents)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {report.lodgment !== null ? (
            <p className="status status--good m-0">
              Lodged {formatDate(report.lodgment.lodgedOn)}
              {report.lodgment.atoReference === null ? '' : `, receipt ${report.lodgment.atoReference}`}. These figures are stored as they stood.
            </p>
          ) : (
            can('bas.finalise') && (
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-[var(--muted)]">Date lodged</span>
                  <input type="date" value={lodgedOn} onChange={(e) => setLodgedOn(e.target.value)} className={inputClass} />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-[var(--muted)]">ATO receipt number (optional)</span>
                  <input value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} className={inputClass} />
                </label>
                <button type="button" className={primaryButtonClass} disabled={busy || incomplete || lodgedOn === ''} onClick={() => setConfirming(true)}>
                  Record as lodged
                </button>
              </div>
            )
          )}
        </>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="section-title m-0">Contractors to report</h3>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 flex flex-col gap-2 max-h-80 overflow-y-auto">
          {vendors.map((v) => (
            <label key={v.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={v.tparReportable === true} disabled={!can('vendors.manage')} onChange={() => void toggle(v)} />
              {v.name}
            </label>
          ))}
          {vendors.length === 0 && <span className="text-sm text-[var(--muted)]">No vendors yet.</span>}
        </div>
      </div>

      {confirming && (
        <ConfirmDialog
          title="Record this report as lodged?"
          body="Only do this once it has really been lodged with the ATO. The figures are stored as they stand now, and can't be changed."
          confirmLabel="Record as lodged"
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void lodge()}
        />
      )}
    </section>
  );
}
