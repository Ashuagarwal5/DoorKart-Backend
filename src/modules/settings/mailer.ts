import nodemailer from 'nodemailer';

import { AppError } from '../../lib/errors.js';
import { readSettings, type SmtpConfig, smtpConfig } from './settings.service.js';

export type MailMessage = { to: string; subject: string; text: string; html?: string };

/** How a message really leaves the server. Tests replace this so no email is ever sent. */
export type MailTransport = (config: SmtpConfig, message: MailMessage) => Promise<void>;

const smtpTransport: MailTransport = async (config, message) => {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    // A mail server that does not answer must not hold a customer's request open for minutes.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    await transporter.sendMail({
      from: { name: config.fromName, address: config.fromEmail },
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
  } finally {
    transporter.close();
  }
};

let transport: MailTransport = smtpTransport;

/** For tests: swap the transport, and get the real one back by passing null. */
export function setMailTransport(replacement: MailTransport | null): void {
  transport = replacement ?? smtpTransport;
}

/** A readable reason for the admin, without ever echoing credentials or server internals. */
function explainFailure(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  switch (code) {
    case 'EAUTH':
      return 'The email server refused the username or password. For Gmail, use an app password, not your normal password.';
    case 'ENOTFOUND':
    case 'ECONNREFUSED':
    case 'ECONNECTION':
      return 'Could not reach the email server. Check the host name and port.';
    case 'ETIMEDOUT':
    case 'ESOCKET':
      return 'The email server did not answer in time. Check the host, the port, and "Secure connection".';
    case 'EENVELOPE':
      return 'The email server did not accept the sender or recipient address.';
    default:
      return 'The email could not be sent. Check the email server settings.';
  }
}

/**
 * Sends one email with the saved SMTP settings. Throws EMAIL_NOT_CONFIGURED if they are
 * incomplete, and EMAIL_SEND_FAILED with a safe explanation if the server refuses.
 */
export async function sendMail(message: MailMessage): Promise<void> {
  const config = smtpConfig(await readSettings());
  if (!config) {
    throw new AppError(
      503,
      'EMAIL_NOT_CONFIGURED',
      'Email is not set up yet. Enter the email server details in Settings first.'
    );
  }
  try {
    await transport(config, message);
  } catch (error) {
    // The cause is logged without credentials (only the error code), for the person running the server.
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    console.error(`[mail] send failed${typeof code === 'string' ? ` (${code})` : ''}`);
    throw new AppError(502, 'EMAIL_SEND_FAILED', explainFailure(error));
  }
}
