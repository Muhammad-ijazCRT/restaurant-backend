import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

function envFirst(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return "";
}

export function isMailConfigured(): boolean {
  const host = envFirst("SMTP_HOST", "MAIL_HOST");
  const user = envFirst("SMTP_USER", "MAIL_USERNAME");
  const pass = envFirst("SMTP_PASS", "MAIL_PASSWORD");
  return Boolean(host && user && pass);
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    const host = envFirst("SMTP_HOST", "MAIL_HOST");
    const port = Number(envFirst("SMTP_PORT", "MAIL_PORT") || "587");
    const user = envFirst("SMTP_USER", "MAIL_USERNAME");
    const pass = envFirst("SMTP_PASS", "MAIL_PASSWORD");
    const secure = envFirst("SMTP_SECURE", "MAIL_ENCRYPTION").toLowerCase() === "ssl" || port === 465;

    transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });
  }
  return transporter;
}

export function mailFromAddress(): string {
  return envFirst("MAIL_FROM_ADDRESS", "SMTP_USER", "MAIL_USERNAME") || "noreply@localhost";
}

export function mailFromName(): string {
  return envFirst("MAIL_FROM_NAME") || "Russian Restaurant Portal";
}

export function normalizePortalEmail(email: string | null | undefined): string | null {
  if (email == null) return null;
  const trimmed = String(email).trim().replace(/[\r\n\t]+/g, "");
  return trimmed || null;
}

export async function sendMail(options: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<void> {
  if (!isMailConfigured()) {
    console.warn("[mail] SMTP not configured — skipping email to", options.to);
    return;
  }

  const to = normalizePortalEmail(options.to);
  if (!to) {
    console.warn("[mail] missing recipient — skipping email");
    return;
  }

  const fromName = mailFromName();
  const fromAddress = mailFromAddress();

  await getTransporter().sendMail({
    from: `"${fromName}" <${fromAddress}>`,
    to,
    subject: options.subject,
    html: options.html,
    text: options.text,
  });
}
