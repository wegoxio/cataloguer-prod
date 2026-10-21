import { MailService } from '../mail.service';

/**
 * The template renderer (Wilfredo's convention: email HTML lives in
 * mail/templates/*.html, never in service strings).
 */
describe('MailService.renderTemplate', () => {
  const service = new MailService({ get: jest.fn().mockReturnValue(null) } as any);

  it('renders every shipped template with its variables interpolated', () => {
    const cases: [string, Record<string, string>, string][] = [
      ['reset-password-email', { email: 'a@acme.com', link: 'https://x/reset?token=t1' }, 'https://x/reset?token=t1'],
      [
        'confirm-email-change',
        { currentEmail: 'a@acme.com', newEmail: 'b@acme.com', link: 'https://x/confirm' },
        'b@acme.com',
      ],
      ['email-changed-notice', { oldEmail: 'old@acme.com', newEmail: 'new@acme.com' }, 'old@acme.com'],
      [
        'welcome-email',
        { actorEmail: 'admin@wegox.com', company: 'Acme C.A.', link: 'https://x/welcome' },
        'Acme C.A.',
      ],
    ];
    for (const [name, vars, mustContain] of cases) {
      const html = service.renderTemplate(name, 'Heading', vars);
      expect(html).toContain(mustContain);
      expect(html).toContain('Heading');
      // The branded shell always wraps the body
      expect(html).toContain('CATALOG');
      // No placeholder survives rendering
      expect(html).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it('escapes user-controlled values so markup in a company name renders as text', () => {
    const html = service.renderTemplate('welcome-email', 'H', {
      actorEmail: 'admin@wegox.com',
      company: '<script>alert(1)</script>',
      link: 'https://x/welcome',
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('leaves the link verbatim — an escaped URL inside href would break the button', () => {
    const html = service.renderTemplate('reset-password-email', 'H', {
      email: 'a@acme.com',
      link: 'https://x/reset?token=abc&expires=1',
    });

    expect(html).toContain('href="https://x/reset?token=abc&expires=1"');
  });

  it('throws on a template that does not exist', () => {
    expect(() => service.renderTemplate('no-such-template', 'H', {})).toThrow();
  });
});
