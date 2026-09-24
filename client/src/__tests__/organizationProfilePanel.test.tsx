import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrganizationProfilePanel from '../Pages/OrganizationProfilePanel';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import * as fetchServices from '../services/fetchServices';
import type { OrganizationProfile, Role } from '../services/fetchServices';

/**
 * OrganizationProfilePanel — Phase 30, Step 17's UI. The organization's postal
 * identity and logo, edited on the Account page's Organisation tab.
 */

const LOGO_ERROR = 'Logo must be a PNG or JPEG under 10 MB';

const EMPTY_PROFILE: OrganizationProfile = {
  legalName: null,
  industry: null,
  streetAddress1: null,
  streetAddress2: null,
  city: null,
  region: null,
  postalCode: null,
  countryCode: null,
  postalSameAsStreet: true,
  postalAddress1: null,
  postalAddress2: null,
  postalCity: null,
  postalRegion: null,
  postalPostalCode: null,
  postalCountryCode: null,
  phone: null,
  contactEmail: null,
  website: null,
  logoDocumentId: null,
  configured: false,
};

const POSTAL_LABELS = [
  'Postal address line 1',
  'Postal address line 2',
  'Postal city',
  'Postal state / region',
  'Postal code (mailing)',
  'Postal country code',
];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function session(role: Role) {
  return {
    success: true,
    user: { id: 'u1', name: 'Ada', email: 'ada@example.com', emailVerified: false, createdAt: '2026-03-04T10:00:00.000Z' },
    organization: { id: 'o1', name: 'Acme', slug: 'acme', baseCurrency: 'USD', createdAt: '2026-02-01T10:00:00.000Z' },
    role,
    memberships: [{ orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role, joinedAt: '2026-05-06T10:00:00.000Z' }],
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

let fetchMock: ReturnType<typeof vi.fn>;
let downloadSpy: ReturnType<typeof vi.spyOn>;
let current: OrganizationProfile;
/** Overrides for one test: a status to answer POST /documents or PATCH with. */
let uploadFails: boolean;
let patchFails: boolean;

beforeEach(() => {
  fetchMock = vi.fn();
  uploadFails = false;
  patchFails = false;
  current = { ...EMPTY_PROFILE };
  vi.stubGlobal('fetch', fetchMock);
  // jsdom implements neither method, so both are stubbed onto URL directly.
  URL.createObjectURL = vi.fn(() => 'blob:mock-logo') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  downloadSpy = vi
    .spyOn(fetchServices, 'downloadDocument')
    .mockResolvedValue({ blob: new Blob(['x'], { type: 'image/png' }), filename: 'logo.png' });
});

afterEach(() => {
  downloadSpy.mockRestore();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  vi.unstubAllGlobals();
});

function mockRoutes(role: Role) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session(role)));
    if (url.includes('/organizations/profile')) {
      if (method === 'PATCH') {
        if (patchFails) {
          return Promise.resolve(
            jsonResponse(422, { success: false, error: 'Logo document does not exist in this organization' }),
          );
        }
        current = { ...current, ...(JSON.parse(String(init?.body)) as object), configured: true };
      }
      return Promise.resolve(jsonResponse(200, { success: true, profile: current }));
    }
    if (url.endsWith('/documents') && method === 'POST') {
      if (uploadFails) return Promise.resolve(jsonResponse(500, { success: false, error: 'Upload exploded' }));
      return Promise.resolve(
        jsonResponse(201, { success: true, created: true, document: { id: 'doc-new' } }),
      );
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unmocked ${method} ${url}` }));
  });
}

/** Every non-auth request made so far, in order. */
function calls(): Call[] {
  return (fetchMock.mock.calls as [RequestInfo | URL, RequestInit | undefined][])
    .map(([input, init]) => ({
      method: init?.method ?? 'GET',
      url: typeof input === 'string' ? input : input.toString(),
      body:
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    }))
    .filter((c) => !c.url.includes('/auth/'));
}

function profilePatches(): Call[] {
  return calls().filter((c) => c.method === 'PATCH' && c.url.includes('/organizations/profile'));
}

async function renderPanel(role: Role = 'OWNER', profile: Partial<OrganizationProfile> = {}) {
  current = { ...EMPTY_PROFILE, ...profile };
  mockRoutes(role);
  // applyAccept is off so the panel's own type check — not user-event's
  // emulation of the input's `accept` attribute — is what rejects a bad file.
  const user = userEvent.setup({ applyAccept: false });
  render(
    <MemoryRouter>
      <AuthProvider>
        <OrgProvider>
          <OrganizationProfilePanel />
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  await screen.findByLabelText('Legal name');
  // The role arrives with /auth/check, which can land after the profile.
  if (role === 'VIEWER') {
    await screen.findByText('Only an OWNER or ADMIN can edit the organization profile.');
  } else {
    await screen.findByLabelText('Upload logo (PNG or JPEG, up to 10 MB)');
  }
  return user;
}

function logoInput(): HTMLInputElement {
  return screen.getByLabelText('Upload logo (PNG or JPEG, up to 10 MB)');
}

function pngFile(name = 'logo.png'): File {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
}

describe('OrganizationProfilePanel', () => {
  it('renders empty inputs and a checked "same as street" box when nothing has been configured', async () => {
    await renderPanel();

    for (const input of screen.getAllByRole('textbox')) {
      expect(input).toHaveValue('');
    }
    expect(screen.getByLabelText('Same as street address')).toBeChecked();
  });

  it('hides the six postal inputs while "same as street" is checked and shows them when unchecked', async () => {
    const user = await renderPanel();
    const same = screen.getByLabelText('Same as street address');

    expect(same).toBeChecked();
    for (const label of POSTAL_LABELS) expect(screen.queryByLabelText(label)).not.toBeInTheDocument();

    await user.click(same);
    expect(same).not.toBeChecked();
    for (const label of POSTAL_LABELS) expect(screen.getByLabelText(label)).toBeInTheDocument();

    await user.click(same);
    for (const label of POSTAL_LABELS) expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
  });

  it('upper-cases the country code as it is typed', async () => {
    const user = await renderPanel();
    const country = screen.getByLabelText('Country code');
    await user.type(country, 'in');
    expect(country).toHaveValue('IN');
  });

  it('Save sends exactly one PATCH carrying the typed city', async () => {
    const user = await renderPanel();
    await user.type(screen.getByLabelText('City'), 'Mumbai');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    const patches = profilePatches();
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toMatchObject({ city: 'Mumbai' });
  });

  it('Save sends a blank legal name as null, not an empty string', async () => {
    const user = await renderPanel('OWNER', { legalName: 'Old Name Pty Ltd', configured: true });
    const legal = screen.getByLabelText('Legal name');
    await user.clear(legal);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Saved.');
    const body = profilePatches()[0]?.body;
    expect(body).toHaveProperty('legalName', null);
    // Every blank text field goes as null; none as ''.
    expect(Object.values(body ?? {})).not.toContain('');
  });

  it('Save never carries logoDocumentId — the logo has its own calls', async () => {
    const user = await renderPanel('OWNER', { logoDocumentId: 'doc-old', configured: true });
    await user.type(screen.getByLabelText('City'), 'Mumbai');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Saved.');
    const body = profilePatches()[0]?.body;
    expect(body).not.toBeNull();
    expect(body).not.toHaveProperty('logoDocumentId');
  });

  it('Save with "same as street" checked sends all six postal fields as null, even if hidden values exist', async () => {
    const user = await renderPanel('OWNER', {
      configured: true,
      postalSameAsStreet: false,
      postalAddress1: 'PO Box 1',
      postalAddress2: 'Level 2',
      postalCity: 'Pune',
      postalRegion: 'MH',
      postalPostalCode: '411001',
      postalCountryCode: 'IN',
    });
    // Seeded from the profile, so the mailing inputs start visible and filled.
    expect(screen.getByLabelText('Postal address line 1')).toHaveValue('PO Box 1');

    await user.click(screen.getByLabelText('Same as street address'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Saved.');
    expect(profilePatches()[0]?.body).toMatchObject({
      postalSameAsStreet: true,
      postalAddress1: null,
      postalAddress2: null,
      postalCity: null,
      postalRegion: null,
      postalPostalCode: null,
      postalCountryCode: null,
    });
  });

  it('Save with "same as street" unchecked sends the typed postal values', async () => {
    const user = await renderPanel();
    await user.click(screen.getByLabelText('Same as street address'));
    await user.type(screen.getByLabelText('Postal address line 1'), 'PO Box 7');
    await user.type(screen.getByLabelText('Postal city'), 'Pune');
    await user.type(screen.getByLabelText('Postal country code'), 'in');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Saved.');
    expect(profilePatches()[0]?.body).toMatchObject({
      postalSameAsStreet: false,
      postalAddress1: 'PO Box 7',
      postalAddress2: null,
      postalCity: 'Pune',
      postalRegion: null,
      postalPostalCode: null,
      postalCountryCode: 'IN',
    });
  });

  describe('logo', () => {
    it('rejects a 12 MB file with a message and makes no request', async () => {
      const user = await renderPanel();
      const before = fetchMock.mock.calls.length;
      const big = new File([new Uint8Array(12 * 1024 * 1024)], 'big.png', { type: 'image/png' });

      await user.upload(logoInput(), big);

      expect(await screen.findByText(LOGO_ERROR)).toBeInTheDocument();
      expect(fetchMock.mock.calls.length).toBe(before);
    });

    it.each([
      ['image/svg+xml', 'logo.svg'],
      ['application/pdf', 'logo.pdf'],
    ])('rejects a %s file with the same message and makes no request', async (type, name) => {
      const user = await renderPanel();
      const before = fetchMock.mock.calls.length;

      await user.upload(logoInput(), new File(['<svg/>'], name, { type }));

      expect(await screen.findByText(LOGO_ERROR)).toBeInTheDocument();
      expect(fetchMock.mock.calls.length).toBe(before);
    });

    it('uploads a valid PNG to the vault, then PATCHes the profile with the new document id', async () => {
      const user = await renderPanel();
      const before = calls().length;

      await user.upload(logoInput(), pngFile());

      await waitFor(() => expect(profilePatches()).toHaveLength(1));
      const made = calls().slice(before);
      expect(made.map((c) => `${c.method} ${c.url.replace(/^.*\/api\/v1/, '')}`)).toEqual([
        'POST /documents',
        'PATCH /organizations/profile',
      ]);
      expect(made[1]?.body).toEqual({ logoDocumentId: 'doc-new' });
      expect(await screen.findByRole('img', { name: 'Organization logo' })).toBeInTheDocument();
    });

    it('surfaces an upload failure and never PATCHes', async () => {
      uploadFails = true;
      const user = await renderPanel();

      await user.upload(logoInput(), pngFile());

      expect(await screen.findByText('Upload exploded')).toBeInTheDocument();
      expect(profilePatches()).toHaveLength(0);
    });

    it('when linking fails after a good upload, shows the error, keeps the previous logo and deletes nothing', async () => {
      const user = await renderPanel('OWNER', { logoDocumentId: 'doc-old', configured: true });
      expect(await screen.findByRole('img', { name: 'Organization logo' })).toBeInTheDocument();
      patchFails = true;

      await user.upload(logoInput(), pngFile());

      expect(await screen.findByText('Logo document does not exist in this organization')).toBeInTheDocument();
      expect(profilePatches()).toHaveLength(1);
      // Still showing the old logo, and it was never re-pointed.
      expect(screen.getByRole('img', { name: 'Organization logo' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Remove logo' })).toBeInTheDocument();
      expect(downloadSpy).toHaveBeenCalledTimes(1);
      expect(downloadSpy).toHaveBeenCalledWith('doc-old');
      // The orphaned vault file is accepted; it must not be cleaned up client-side.
      expect(calls().filter((c) => c.method === 'DELETE')).toHaveLength(0);
    });

    it('shows the logo and a Remove logo button; clicking it PATCHes logoDocumentId null', async () => {
      const user = await renderPanel('OWNER', { logoDocumentId: 'doc-old', configured: true });
      expect(await screen.findByRole('img', { name: 'Organization logo' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Remove logo' }));

      await waitFor(() => expect(profilePatches()).toHaveLength(1));
      expect(profilePatches()[0]?.body).toEqual({ logoDocumentId: null });
      await waitFor(() => expect(screen.queryByRole('img', { name: 'Organization logo' })).not.toBeInTheDocument());
      expect(screen.queryByRole('button', { name: 'Remove logo' })).not.toBeInTheDocument();
    });
  });

  it('a VIEWER sees disabled inputs and a read-only note, with no Save, upload or Remove logo', async () => {
    await renderPanel('VIEWER', { logoDocumentId: 'doc-old', configured: true });

    expect(screen.getByText('Only an OWNER or ADMIN can edit the organization profile.')).toBeInTheDocument();
    for (const input of screen.getAllByRole('textbox')) expect(input).toBeDisabled();
    expect(screen.getByLabelText('Same as street address')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Upload logo (PNG or JPEG, up to 10 MB)')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove logo' })).not.toBeInTheDocument();
    // Reading is allowed: the logo itself is still shown.
    expect(await screen.findByRole('img', { name: 'Organization logo' })).toBeInTheDocument();
  });
});
