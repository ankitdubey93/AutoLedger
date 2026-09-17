import { z } from 'zod';

/** PUT /ap-flow/drive/folder — a pasted Drive folder link or bare id. */
export const setDriveFolderSchema = z.object({
  folder: z.string().trim().min(1).max(500),
});

export type SetDriveFolderInput = z.infer<typeof setDriveFolderSchema>;
