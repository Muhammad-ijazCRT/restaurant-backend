import { buildPortalEmailHtml } from "./template.js";
import { isMailConfigured, sendMail } from "./mailer.js";

function frontendBaseUrl(): string {
  return process.env.FRONTEND_URL?.trim() || process.env.CORS_ORIGIN?.trim() || "http://localhost:3000";
}

export async function sendPasswordResetEmail(options: {
  to: string;
  name: string;
  portal: "restaurant" | "vendor";
  resetToken: string;
}): Promise<void> {
  const portalLabel = options.portal === "restaurant" ? "Restaurant" : "Vendor";
  const resetUrl = `${frontendBaseUrl()}/${options.portal}/reset-password?token=${encodeURIComponent(options.resetToken)}`;

  const html = buildPortalEmailHtml({
    title: "Reset your password",
    recipientName: options.name,
    message: `We received a request to reset your ${portalLabel} portal password.`,
    messageParagraphs: [
      `We received a request to reset your ${portalLabel} portal password.`,
      "Click the button below to choose a new password. This link expires in 1 hour.",
      "If you did not request a password reset, you can safely ignore this email.",
    ],
    portalUrl: resetUrl,
    buttonLabel: "Reset Password",
    footerNote: "For security, this link can only be used once and expires after 1 hour.",
  });

  if (!isMailConfigured()) {
    console.warn("[password-reset] SMTP not configured. Reset link:", resetUrl);
    return;
  }

  await sendMail({
    to: options.to,
    subject: `Reset your ${portalLabel} portal password`,
    html,
    text: `Reset your password: ${resetUrl}`,
  });
}
