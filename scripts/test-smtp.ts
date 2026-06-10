import { isMailConfigured, mailFromAddress, sendMail } from "../src/lib/mailer";
import { buildPortalEmailHtml } from "../src/lib/email-template";

if (!isMailConfigured()) {
  console.error("SMTP is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env");
  process.exit(1);
}

const to = process.argv[2]?.trim() || mailFromAddress();
const html = buildPortalEmailHtml({
  title: "Order placed",
  message: "You placed order #1001",
  recipientName: "Test User",
  orderDisplayId: 1001,
  restaurantName: "Demo Restaurant",
  vendorName: "Demo Vendor",
});

await sendMail({
  to,
  subject: "SMTP test — Russian Restaurant Portal",
  html,
  text: "SMTP test email from Russian Restaurant Portal",
});

console.log(`Test email sent to ${to}`);
