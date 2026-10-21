import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Thin Resend client (plain fetch, no SDK). Unconfigured deployments log
 * and return false instead of failing the calling flow — password reset
 * responses stay generic either way.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly configService: ConfigService) {}

  get isConfigured(): boolean {
    return Boolean(this.configService.get<string>('RESEND_API_KEY'));
  }

  private get from(): string {
    return this.configService.get<string>('MAIL_FROM') || 'onboarding@resend.dev';
  }

  /**
   * Shared brand shell for every email: navy header with the wordmark and
   * orange spark (text-based — SVG/webfonts don't survive email clients),
   * light card body, quiet footer. Callers pass the heading + inner HTML.
   */
  /**
   * Renders a named template from mail/templates (P2 backlog — Wilfredo's
   * convention: email HTML lives in .html files, not in service strings).
   *
   * `{{placeholders}}` are replaced with HTML-ESCAPED values: template
   * variables carry user input (emails, company names), and an unescaped
   * "<script>" in a company name must render as text, never as markup.
   * Files are cached after first read; the branded shell wraps the result.
   */
  renderTemplate(templateName: string, heading: string, vars: Record<string, string>): string {
    let body = MailService.templateCache.get(templateName);
    if (body === undefined) {
      const file = join(__dirname, 'templates', `${templateName}.html`);
      body = readFileSync(file, 'utf-8');
      MailService.templateCache.set(templateName, body);
    }
    const escape = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const rendered = body.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      // A link is the one value that must survive verbatim inside href="…"
      const raw = vars[key] ?? '';
      return key === 'link' ? raw : escape(raw);
    });
    return this.brandedHtml(heading, rendered);
  }

  private static readonly templateCache = new Map<string, string>();

  brandedHtml(heading: string, bodyHtml: string): string {
    return `<div style="background:#f4f6fc;padding:24px 12px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif">
      <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e7ecf6">
        <div style="background:#101623;padding:16px 24px">
          <span style="color:#ffffff;font-size:17px;font-weight:800;font-style:italic;letter-spacing:1.5px">CATALOG</span><span style="display:inline-block;width:8px;height:8px;background:#f7931e;border-radius:99px;margin-left:7px"></span>
        </div>
        <div style="padding:24px">
          <h2 style="color:#161b2e;margin:0 0 12px;font-size:19px">${heading}</h2>
          ${bodyHtml}
        </div>
        <div style="padding:13px 24px;border-top:1px solid #eef1f6;color:#94a3b8;font-size:12px">Catalog by Wegox</div>
      </div>
    </div>`;
  }

  async send(to: string, subject: string, html: string): Promise<boolean> {
    if (!this.isConfigured) {
      this.logger.warn(`Mail not configured (RESEND_API_KEY missing) — dropped email to ${to}`);
      return false;
    }
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.configService.get<string>('RESEND_API_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: `Catalog by Wegox <${this.from}>`, to: [to], subject, html }),
      });
      if (!response.ok) {
        this.logger.error(`Resend rejected email to ${to}: ${response.status} ${await response.text()}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.error(`Failed to send email to ${to}: ${err?.message}`);
      return false;
    }
  }
}
