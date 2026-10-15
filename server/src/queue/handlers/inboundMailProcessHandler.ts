import { processInboundMessage } from '../../services/integrations/inboundMailService.js';
import type { JobPayloads } from '../../types/jobs.js';

/** Phase 43d — imports one received email's attachments into the bill inbox. */
export async function handleInboundMailProcess(payload: JobPayloads['inbound-mail-process']): Promise<void> {
  await processInboundMessage(payload.orgId, payload.messageId, payload.attachments);
}
