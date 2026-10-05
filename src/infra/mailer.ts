import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';

export interface Mail { to: string; subject: string; text: string; html?: string }

/** SMTP when SMTP_URL is set (Mailpit locally, Postmark/SES in prod); otherwise logs. Tests read `Mailer.outbox`. */
@Injectable()
export class Mailer {
  static outbox: Mail[] = [];
  private readonly log = new Logger('Mailer');
  private readonly transport: Transporter | null = env.SMTP_URL && env.NODE_ENV !== 'test' ? nodemailer.createTransport(env.SMTP_URL) : null;

  async send(m: Mail) {
    if (env.NODE_ENV === 'test') { Mailer.outbox.push(m); return; }
    if (!this.transport) { this.log.log(`[mail → ${m.to}] ${m.subject}\n${m.text}`); return; }
    await this.transport.sendMail({ from: env.MAIL_FROM, ...m });
  }
}
