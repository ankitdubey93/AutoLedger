import { z } from 'zod';

/**
 * Request schema for editing the organization's postal identity. Platform layer.
 * Mirrors the contract in the plan.
 */
export const updateOrganizationProfileSchema = z
  .object({
    legalName: z.string().trim().min(1).max(200).nullable().optional(),
    industry: z.string().trim().max(120).nullable().optional(),
    streetAddress1: z.string().trim().max(200).nullable().optional(),
    streetAddress2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    region: z.string().trim().max(120).nullable().optional(),
    postalCode: z.string().trim().max(32).nullable().optional(),
    countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/, 'countryCode must be a 2-letter ISO code').nullable().optional(),
    postalSameAsStreet: z.boolean().optional(),
    postalAddress1: z.string().trim().max(200).nullable().optional(),
    postalAddress2: z.string().trim().max(200).nullable().optional(),
    postalCity: z.string().trim().max(120).nullable().optional(),
    postalRegion: z.string().trim().max(120).nullable().optional(),
    postalPostalCode: z.string().trim().max(32).nullable().optional(),
    postalCountryCode: z.string().trim().regex(/^[A-Za-z]{2}$/, 'postalCountryCode must be a 2-letter ISO code').nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    contactEmail: z.email().max(254).nullable().optional(),
    website: z.string().trim().max(200).nullable().optional(),
    logoDocumentId: z.uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });
