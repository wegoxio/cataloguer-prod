import { apiFetch } from '../../../lib/api-client';
import type { ImportRecord } from '../types/import-record.types';

/** Endpoints of the import module, so components never carry raw paths. */
export const importService = {
  async getHistory(token: string): Promise<ImportRecord[]> {
    const response = await apiFetch('/import/history', { method: 'GET', token });
    return response?.data ?? [];
  },
};
