import { useEffect, useState } from 'react';
import {
  getInvoiceSettings,
  getOrganizationProfile,
  getStatementSettings,
  type OrganizationProfile,
  type StatementSettings,
} from '../../services/fetchServices';
import { useOrg } from '../../context/OrgContext';
import { useDocumentObjectUrl } from '../../utils/useDocumentObjectUrl';
import { addressLines } from '../sales/InvoiceDocument';

export interface StatementBranding {
  settings: StatementSettings | null;
  organizationName: string;
  orgAddressLines: string[];
  baseCurrency: string;
  logoSrc: string | null;
  bankDetails: string | null;
  /** True once the statement settings have loaded (or failed). */
  ready: boolean;
}

/**
 * Everything a `StatementDocument` needs besides the statement itself, for a
 * signed-in member (Phase 39a). The profile and invoice settings are
 * decoration — a failed fetch renders a statement without a logo, address or
 * remittance block, never a broken page.
 */
export function useStatementBranding(): StatementBranding & {
  profile: OrganizationProfile | null;
} {
  const { organization } = useOrg();
  const [settings, setSettings] = useState<StatementSettings | null>(null);
  const [profile, setProfile] = useState<OrganizationProfile | null>(null);
  const [bankDetails, setBankDetails] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      getStatementSettings(controller.signal).catch(() => null),
      getOrganizationProfile(controller.signal).catch(() => null),
      getInvoiceSettings(controller.signal).catch(() => null),
    ])
      .then(([statementSettings, orgProfile, invoiceSettings]) => {
        if (controller.signal.aborted) return;
        setSettings(statementSettings);
        setProfile(orgProfile);
        setBankDetails(invoiceSettings?.bankDetails ?? null);
        setReady(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setReady(true);
      });
    return () => controller.abort();
  }, []);

  const logoSrc = useDocumentObjectUrl(profile?.logoDocumentId ?? null);

  return {
    settings,
    profile,
    organizationName: organization?.name ?? '',
    orgAddressLines: profile !== null ? addressLines(profile) : [],
    baseCurrency: organization?.baseCurrency ?? '',
    logoSrc,
    bankDetails,
    ready,
  };
}
