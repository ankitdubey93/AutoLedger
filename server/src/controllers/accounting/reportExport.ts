import type { Request, Response } from 'express';
import { renderReportPdf } from '../../services/accounting/reportPdfRenderer.js';
import { ApiError } from '../../utils/apiError.js';
import { buildReportCsv } from '../../utils/reportCsv.js';
import { buildXlsx, XLSX_CONTENT_TYPE } from '../../utils/xlsxWriter.js';
import { isReportFormat, type ReportFormat, type ReportTable } from '../../types/reportTable.js';

/**
 * Export helpers for report routes. No SQL (guardrails rule 2).
 */

/** `?format` absent → null. Present but not csv|xlsx|pdf → 400. */
export function readReportFormat(req: Request): ReportFormat | null {
  const value = req.query.format;
  if (value === undefined) return null;
  if (typeof value !== 'string' || !isReportFormat(value)) {
    throw new ApiError(400, 'format must be one of csv, xlsx, pdf');
  }
  return value;
}

async function renderBody(
  table: ReportTable,
  format: ReportFormat,
): Promise<{ contentType: string; body: string | Buffer }> {
  switch (format) {
    case 'csv':
      return { contentType: 'text/csv; charset=utf-8', body: buildReportCsv(table) };
    case 'xlsx':
      return { contentType: XLSX_CONTENT_TYPE, body: buildXlsx(table) };
    case 'pdf':
      return { contentType: 'application/pdf', body: await renderReportPdf(table) };
  }
}

export async function sendReportFile(res: Response, table: ReportTable, format: ReportFormat): Promise<void> {
  const { contentType, body } = await renderBody(table, format);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${table.filenameStem}.${format}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(body);
}
