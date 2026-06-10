function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildPortalEmailHtml(options: {
  title: string;
  message: string;
  messageParagraphs?: string[];
  recipientName?: string;
  orderDisplayId?: string | number;
  restaurantName?: string;
  vendorName?: string;
  createdByName?: string;
  portalUrl?: string;
  nextSteps?: string[];
  buttonLabel?: string;
  footerNote?: string;
  loginReminder?: string;
  loginCredentials?: {
    email: string;
    password: string;
    loginUrl: string;
  };
}): string {
  const {
    title,
    message,
    messageParagraphs,
    recipientName,
    orderDisplayId,
    restaurantName,
    vendorName,
    createdByName,
    portalUrl = process.env.CORS_ORIGIN?.trim() || "http://localhost:3000",
    nextSteps,
    buttonLabel,
    footerNote,
    loginReminder,
    loginCredentials,
  } = options;

  const paragraphs = messageParagraphs?.length ? messageParagraphs : [message];
  const messageHtml = paragraphs
    .map(
      (paragraph) =>
        `<p style="margin:0 0 14px;font-size:16px;line-height:1.65;color:#0f172a;">${escapeHtml(paragraph)}</p>`,
    )
    .join("");

  const details: string[] = [];
  if (orderDisplayId != null && orderDisplayId !== "") {
    details.push(`<tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Order</td><td style="padding:8px 0;font-size:13px;font-weight:600;color:#0f172a;">#${escapeHtml(String(orderDisplayId))}</td></tr>`);
  }
  if (vendorName) {
    details.push(`<tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Vendor</td><td style="padding:8px 0;font-size:13px;color:#0f172a;">${escapeHtml(vendorName)}</td></tr>`);
  }
  if (restaurantName) {
    details.push(`<tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Restaurant</td><td style="padding:8px 0;font-size:13px;color:#0f172a;">${escapeHtml(restaurantName)}</td></tr>`);
  }
  if (createdByName) {
    details.push(`<tr><td style="padding:8px 0;color:#64748b;font-size:13px;">Created by</td><td style="padding:8px 0;font-size:13px;color:#0f172a;">${escapeHtml(createdByName)}</td></tr>`);
  }

  const detailsBlock = details.length > 0
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:20px;border-top:1px solid #e2e8f0;padding-top:12px;">${details.join("")}</table>`
    : "";

  const credentialsBlock = loginCredentials
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:8px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;">
        <tr>
          <td style="padding:16px 18px;">
            <div style="font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;">Your Login Credentials</div>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:10px;">
              <tr><td style="padding:6px 0;color:#64748b;font-size:13px;width:110px;">Email</td><td style="padding:6px 0;font-size:13px;font-weight:600;color:#0f172a;">${escapeHtml(loginCredentials.email)}</td></tr>
              <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Password</td><td style="padding:6px 0;font-size:13px;font-weight:600;color:#0f172a;">${escapeHtml(loginCredentials.password)}</td></tr>
            </table>
            <p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:#64748b;">For security, please change your password after your first sign-in.</p>
          </td>
        </tr>
      </table>`
    : "";

  const nextStepsBlock = nextSteps?.length
    ? `<div style="margin-top:20px;padding:16px 18px;border:1px solid #e2e8f0;border-radius:10px;background:#fff7ed;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#c2410c;">Next Steps</div>
        <ul style="margin:10px 0 0;padding-left:18px;color:#334155;font-size:14px;line-height:1.7;">
          ${nextSteps.map((step) => `<li style="margin-bottom:6px;">${escapeHtml(step)}</li>`).join("")}
        </ul>
      </div>`
    : "";

  const ctaLabel =
    buttonLabel ?? (loginCredentials ? "Sign In & Review Your Account" : "Open Portal");
  const defaultFooter =
    "This is an automated notification from Russian Restaurant Portal. You received it because your account is linked to this activity.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px rgba(15,23,42,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,#ea580c,#c2410c);padding:24px 28px;">
              <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#ffedd5;font-weight:600;">Russian Restaurant Portal</div>
              <div style="margin-top:8px;font-size:22px;line-height:1.3;font-weight:700;color:#ffffff;">${escapeHtml(title)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              ${recipientName ? `<p style="margin:0 0 16px;font-size:14px;color:#64748b;">Dear ${escapeHtml(recipientName)},</p>` : ""}
              ${messageHtml}
              ${detailsBlock}
              ${credentialsBlock}
              ${nextStepsBlock}
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:28px;">
                <tr>
                  <td style="border-radius:8px;background:#ea580c;">
                    <a href="${escapeHtml(loginCredentials?.loginUrl ?? portalUrl)}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(ctaLabel)}</a>
                  </td>
                </tr>
              </table>
              ${loginReminder ? `<p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:#64748b;">${escapeHtml(loginReminder)}</p>` : ""}
            </td>
          </tr>
          <tr>
            <td style="padding:18px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:#94a3b8;">${escapeHtml(footerNote ?? defaultFooter)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
