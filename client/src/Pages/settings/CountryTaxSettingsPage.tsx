import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import {
  activateAustralia,
  deactivateAustralia,
  updateGstSettings,
  type GstSettings,
} from '../../services/fetchServices';
import { useLedgerSettings } from '../../context/LedgerSettingsContext';
import PageHeader from '../../components/ui/PageHeader';
import { primaryButtonClass, secondaryButtonClass } from '../../components/ui/formClasses';
import ConfirmDialog from '../../components/ConfirmDialog';
import SettingsTabs from './SettingsTabs';
import GstFields, { AU_TIME_ZONES, DEFAULT_GST } from './GstFields';

/**
 * Phase 49a: the path onto the Australian edition for an organization that
 * already exists, and where an Australian organization edits its GST choices.
 */
export default function CountryTaxSettingsPage() {
  const ledger = useLedgerSettings();
  const [gst, setGst] = useState<GstSettings>(DEFAULT_GST);
  const [timeZone, setTimeZone] = useState('Australia/Sydney');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  const settings = ledger.status === 'ready' ? ledger.settings : null;
  const isAustralian = settings?.region === 'AU';
  const savedGst = settings?.gst ?? null;
  const savedZone = settings?.timezone ?? null;

  useEffect(() => {
    if (savedGst !== null) setGst(savedGst);
    if (savedZone !== null && AU_TIME_ZONES.some((z) => z.value === savedZone)) setTimeZone(savedZone);
  }, [savedGst, savedZone]);

  async function run(action: () => Promise<Parameters<typeof ledger.applySettings>[0]>) {
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      ledger.applySettings(await action());
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="shell flex flex-col gap-6">
      <PageHeader icon={Globe} title="Country & GST" />
      <SettingsTabs />

      {settings === null ? (
        <div className="skeleton skeleton--title" aria-busy="true" />
      ) : (
        <div className="flex flex-col gap-4 max-w-xl">
          {isAustralian ? (
            <p className="text-sm m-0">This organization uses the Australian edition.</p>
          ) : (
            <p className="text-sm m-0">
              Switch to the Australian edition for GST, BAS and Australian formats. It reports in AUD, so an
              organization with entries in another currency can't switch.
            </p>
          )}

          <GstFields value={gst} onChange={setGst} timeZone={timeZone} onTimeZoneChange={setTimeZone} disabled={saving} />

          {error !== null && <p className="status status--bad">{error}</p>}
          {saved && <p className="status status--good">Saved.</p>}

          <div className="flex gap-3">
            <button
              type="button"
              className={primaryButtonClass}
              disabled={saving}
              onClick={() => void run(isAustralian ? () => updateGstSettings({ ...gst, timezone: timeZone }) : () => activateAustralia({ gst, timezone: timeZone }))}
            >
              {isAustralian ? 'Save' : 'Switch to Australia'}
            </button>
            {isAustralian && (
              <button type="button" className={secondaryButtonClass} disabled={saving} onClick={() => setConfirmingLeave(true)}>
                Leave the Australian edition
              </button>
            )}
          </div>
        </div>
      )}

      {confirmingLeave && (
        <ConfirmDialog
          title="Leave the Australian edition?"
          body="GST settings are removed. Accounts already added or renamed stay as they are."
          confirmLabel="Leave"
          onCancel={() => setConfirmingLeave(false)}
          onConfirm={() => {
            setConfirmingLeave(false);
            void run(deactivateAustralia);
          }}
        />
      )}
    </section>
  );
}
