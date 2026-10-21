import { apiFetch } from '../../../../lib/api-client';
import type {
  AppliedTemplateResponse,
  PreviewResponse,
  SourceSample,
  TableMapping,
  TemplateSummary,
  WizardContract,
} from './wizard-contract.types';

/**
 * Every wizard endpoint, so no component carries a raw path.
 *
 * The preview call is the one that runs constantly — on every mapping change —
 * so it sends the bounded sample it already holds rather than asking the server
 * to re-read a source that may be a hundred megabytes. The sample is the
 * customer's own data going back to them; nothing is disclosed that they did
 * not already have.
 */
export const wizardService = {
  /** What this deployment can actually do. Fetched once, per session. */
  async getContract(token: string): Promise<WizardContract> {
    const response = await apiFetch('/import/wizard/contract', { method: 'GET', token });
    return response.data as WizardContract;
  },

  async preview(
    token: string,
    body: { importType: string; sample: SourceSample; mapping: TableMapping },
  ): Promise<PreviewResponse> {
    const response = await apiFetch('/import/wizard/preview', {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    });
    return response.data as PreviewResponse;
  },

  async listTemplates(token: string, importType?: string): Promise<TemplateSummary[]> {
    const query = importType ? `?importType=${encodeURIComponent(importType)}` : '';
    const response = await apiFetch(`/import/wizard/templates${query}`, { method: 'GET', token });
    return (response?.data ?? []) as TemplateSummary[];
  },

  async saveTemplate(
    token: string,
    body: { name: string; importType: string; mapping: TableMapping; headers: string[]; types: string[] },
  ): Promise<{ id: string; name: string; version: number }> {
    const response = await apiFetch('/import/wizard/templates', {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    });
    return response.data;
  },

  /**
   * Re-bind a saved mapping to the file in front of us.
   *
   * The response always carries the drift findings. A template applied without
   * them is the one case where the wizard could write wrong values with nobody
   * having looked, so the caller cannot get the mapping without them.
   */
  async applyTemplate(
    token: string,
    templateId: string,
    shape: { headers: string[]; types: string[] },
  ): Promise<AppliedTemplateResponse> {
    const response = await apiFetch(`/import/wizard/templates/${encodeURIComponent(templateId)}/apply`, {
      method: 'POST',
      token,
      body: JSON.stringify(shape),
    });
    return response.data as AppliedTemplateResponse;
  },

  async archiveTemplate(token: string, templateId: string): Promise<void> {
    await apiFetch(`/import/wizard/templates/${encodeURIComponent(templateId)}`, { method: 'DELETE', token });
  },
};
