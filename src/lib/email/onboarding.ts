import type { RestaurantEmployee, RestaurantOrg, Vendor } from "../../db/schema.js";
import { storage } from "../../services/storage.js";
import { buildPortalEmailHtml } from "./template.js";
import { isMailConfigured, normalizePortalEmail, sendMail } from "./mailer.js";
import { getPrimaryRoleLabel } from "../permissions/restaurant-employee.js";

function portalOrigin(): string {
  return process.env.FRONTEND_URL?.trim() || process.env.CORS_ORIGIN?.trim() || "http://localhost:3000";
}

function emailsEnabled(): boolean {
  return isMailConfigured() && process.env.ENABLE_ACTIVITY_EMAILS !== "false";
}

const ONBOARDING_FOOTER =
  "This is an automated message from Russian Restaurant Portal. If you did not expect this email, please contact your platform administrator.";

const LOGIN_REMINDER =
  "Please log in at your earliest convenience to review your account and confirm that everything is set up correctly.";

export async function sendVendorWelcomeEmail(options: {
  vendor: Pick<Vendor, "name" | "contactName" | "email">;
  loginPassword: string;
}): Promise<void> {
  if (!emailsEnabled() || !options.loginPassword.trim()) return;

  const loginUrl = `${portalOrigin()}/vendor/login`;
  const recipientName = options.vendor.contactName || options.vendor.name;
  const messageParagraphs = [
    `Your vendor account for ${options.vendor.name} has been successfully created on Russian Restaurant Portal. You now have secure access to manage your product catalog, warehouse team, drivers, and restaurant orders from one place.`,
    "Please sign in using the credentials below and review your company profile. We recommend updating your password after your first login to keep your account secure.",
  ];
  const nextSteps = [
    "Sign in to your vendor portal using the email and password provided below",
    "Review your company profile and contact information",
    "Add products to your catalog and configure your team",
    "Check for linked restaurants and monitor incoming orders",
  ];

  const vendorEmail = normalizePortalEmail(options.vendor.email);
  if (!vendorEmail) return;

  await sendMail({
    to: vendorEmail,
    subject: "Your vendor portal account is ready",
    html: buildPortalEmailHtml({
      title: "Welcome to the Vendor Portal",
      message: messageParagraphs.join(" "),
      messageParagraphs,
      recipientName,
      vendorName: options.vendor.name,
      portalUrl: loginUrl,
      nextSteps,
      buttonLabel: "Sign In & Review Your Account",
      loginReminder: LOGIN_REMINDER,
      footerNote: ONBOARDING_FOOTER,
      loginCredentials: {
        email: options.vendor.email,
        password: options.loginPassword,
        loginUrl,
      },
    }),
    text:
      `Dear ${recipientName},\n\n` +
      `${messageParagraphs.join("\n\n")}\n\n` +
      `Your login credentials:\n` +
      `Email: ${options.vendor.email}\n` +
      `Password: ${options.loginPassword}\n\n` +
      `Next steps:\n` +
      `${nextSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n` +
      `${LOGIN_REMINDER}\n` +
      `Sign in: ${loginUrl}\n`,
  });
}

export async function sendRestaurantWelcomeEmail(options: {
  restaurant: Pick<RestaurantOrg, "name" | "contactName" | "email">;
  loginPassword: string;
}): Promise<void> {
  if (!emailsEnabled() || !options.loginPassword.trim()) return;

  const loginUrl = `${portalOrigin()}/restaurant/login`;
  const recipientName = options.restaurant.contactName || options.restaurant.name;
  const messageParagraphs = [
    `Your restaurant organization, ${options.restaurant.name}, has been successfully registered on Russian Restaurant Portal. You can now connect with approved vendors, place orders, and track deliveries through your restaurant dashboard.`,
    "Please sign in using the credentials below and review your organization details. For your security, we recommend changing your password after your first login.",
  ];
  const nextSteps = [
    "Sign in to your restaurant portal using the email and password provided below",
    "Review your organization profile and contact details",
    "Check your linked vendors and available product catalogs",
    "Start placing and tracking orders from your dashboard",
  ];

  const restaurantEmail = normalizePortalEmail(options.restaurant.email);
  if (!restaurantEmail) return;

  await sendMail({
    to: restaurantEmail,
    subject: "Your restaurant portal account is ready",
    html: buildPortalEmailHtml({
      title: "Welcome to the Restaurant Portal",
      message: messageParagraphs.join(" "),
      messageParagraphs,
      recipientName,
      restaurantName: options.restaurant.name,
      portalUrl: loginUrl,
      nextSteps,
      buttonLabel: "Sign In & Review Your Account",
      loginReminder: LOGIN_REMINDER,
      footerNote: ONBOARDING_FOOTER,
      loginCredentials: {
        email: options.restaurant.email,
        password: options.loginPassword,
        loginUrl,
      },
    }),
    text:
      `Dear ${recipientName},\n\n` +
      `${messageParagraphs.join("\n\n")}\n\n` +
      `Your login credentials:\n` +
      `Email: ${options.restaurant.email}\n` +
      `Password: ${options.loginPassword}\n\n` +
      `Next steps:\n` +
      `${nextSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n` +
      `${LOGIN_REMINDER}\n` +
      `Sign in: ${loginUrl}\n`,
  });
}

export async function sendRestaurantEmployeeWelcomeEmail(options: {
  employee: Pick<RestaurantEmployee, "name" | "email" | "roles">;
  restaurant: Pick<RestaurantOrg, "name">;
  loginPassword: string;
}): Promise<void> {
  if (!emailsEnabled() || !options.loginPassword.trim()) return;

  const loginUrl = `${portalOrigin()}/restaurant/login`;
  const roleLabel = getPrimaryRoleLabel(options.employee.roles);
  const recipientName = options.employee.name;
  const messageParagraphs = [
    `You have been added as a ${roleLabel} team member for ${options.restaurant.name} on Russian Restaurant Portal.`,
    "Please sign in using the credentials below to access your restaurant dashboard. For your security, we recommend changing your password after your first login.",
  ];
  const nextSteps = [
    "Sign in to the restaurant portal using the email and password provided below",
    "Review your dashboard and linked vendors",
    "Place and track orders based on your role permissions",
    "Contact your restaurant owner if you need additional access",
  ];

  const employeeEmail = normalizePortalEmail(options.employee.email);
  if (!employeeEmail) return;

  await sendMail({
    to: employeeEmail,
    subject: `Your ${options.restaurant.name} restaurant portal account is ready`,
    html: buildPortalEmailHtml({
      title: "Welcome to the Restaurant Portal",
      message: messageParagraphs.join(" "),
      messageParagraphs,
      recipientName,
      restaurantName: options.restaurant.name,
      portalUrl: loginUrl,
      nextSteps,
      buttonLabel: "Sign In to Restaurant Portal",
      loginReminder: LOGIN_REMINDER,
      footerNote: ONBOARDING_FOOTER,
      loginCredentials: {
        email: options.employee.email,
        password: options.loginPassword,
        loginUrl,
      },
    }),
    text:
      `Dear ${recipientName},\n\n` +
      `${messageParagraphs.join("\n\n")}\n\n` +
      `Role: ${roleLabel}\n` +
      `Restaurant: ${options.restaurant.name}\n\n` +
      `Your login credentials:\n` +
      `Email: ${options.employee.email}\n` +
      `Password: ${options.loginPassword}\n\n` +
      `Next steps:\n` +
      `${nextSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n` +
      `${LOGIN_REMINDER}\n` +
      `Sign in: ${loginUrl}\n`,
  });
}

export async function sendRelationshipCreatedEmails(options: {
  vendorId: string;
  restaurantOrgId: string;
  createdByName: string;
}): Promise<void> {
  if (!emailsEnabled()) return;

  const [vendorRecord, restaurantRecord] = await Promise.all([
    storage.getVendor(options.vendorId),
    storage.getRestaurantOrg(options.restaurantOrgId),
  ]);
  if (!vendorRecord || !restaurantRecord) {
    console.warn("[mail] relationship emails skipped — vendor or restaurant not found", options);
    return;
  }

  const vendorEmail = normalizePortalEmail(vendorRecord.email);
  const restaurantEmail = normalizePortalEmail(restaurantRecord.email);
  if (!vendorEmail || !restaurantEmail) {
    console.warn("[mail] relationship emails skipped — missing vendor or restaurant email", {
      vendorId: options.vendorId,
      restaurantOrgId: options.restaurantOrgId,
      vendorEmail,
      restaurantEmail,
    });
    return;
  }

  const vendor = vendorRecord;
  const restaurant = restaurantRecord;
  const vendorRecipient = vendor.contactName || vendor.name;
  const restaurantRecipient = restaurant.contactName || restaurant.name;
  const vendorLoginUrl = `${portalOrigin()}/vendor/login`;
  const restaurantLoginUrl = `${portalOrigin()}/restaurant/login`;

  const vendorParagraphs = [
    `A new business partnership has been established between your vendor account, ${vendor.name}, and ${restaurant.name}.`,
    `This relationship was created by ${options.createdByName}. You can now receive, prepare, and fulfill orders from this restaurant directly through your vendor portal.`,
    "Please log in to review the partnership details and check your dashboard for any new activity.",
  ];
  const restaurantParagraphs = [
    `A new business partnership has been established between your restaurant, ${restaurant.name}, and ${vendor.name}.`,
    `This relationship was created by ${options.createdByName}. You can now browse this vendor's catalog and place orders through your restaurant portal.`,
    "Please log in to review the partnership and confirm that the vendor is visible in your account.",
  ];
  const vendorNextSteps = [
    "Sign in to your vendor portal",
    `Review your new partnership with ${restaurant.name}`,
    "Confirm your product catalog and fulfillment team are ready",
    "Monitor your dashboard for incoming orders from this restaurant",
  ];
  const restaurantNextSteps = [
    "Sign in to your restaurant portal",
    `Review your new partnership with ${vendor.name}`,
    "Browse the vendor catalog and verify available products",
    "Place your first order when you are ready",
  ];

  console.log("[mail] relationship emails", {
    vendorTo: vendorEmail,
    restaurantTo: restaurantEmail,
    vendorName: vendor.name,
    restaurantName: restaurant.name,
  });

  await sendMail({
    to: vendorEmail,
    subject: `New partnership with ${restaurant.name}`,
    html: buildPortalEmailHtml({
      title: "New Restaurant Partnership",
      message: vendorParagraphs.join(" "),
      messageParagraphs: vendorParagraphs,
      recipientName: vendorRecipient,
      vendorName: vendor.name,
      restaurantName: restaurant.name,
      createdByName: options.createdByName,
      portalUrl: vendorLoginUrl,
      nextSteps: vendorNextSteps,
      buttonLabel: "Log In & Review Partnership",
      loginReminder: "Please sign in today to review this partnership and make sure your account is ready to receive orders.",
      footerNote: ONBOARDING_FOOTER,
    }),
    text:
      `Dear ${vendorRecipient},\n\n` +
      `${vendorParagraphs.join("\n\n")}\n\n` +
      `Restaurant: ${restaurant.name}\n` +
      `Created by: ${options.createdByName}\n\n` +
      `Next steps:\n` +
      `${vendorNextSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n` +
      `Sign in: ${vendorLoginUrl}\n`,
  });

  await sendMail({
    to: restaurantEmail,
    subject: `New partnership with ${vendor.name}`,
    html: buildPortalEmailHtml({
      title: "New Vendor Partnership",
      message: restaurantParagraphs.join(" "),
      messageParagraphs: restaurantParagraphs,
      recipientName: restaurantRecipient,
      vendorName: vendor.name,
      restaurantName: restaurant.name,
      createdByName: options.createdByName,
      portalUrl: restaurantLoginUrl,
      nextSteps: restaurantNextSteps,
      buttonLabel: "Log In & Review Partnership",
      loginReminder: "Please sign in today to review this partnership and confirm the vendor is available in your portal.",
      footerNote: ONBOARDING_FOOTER,
    }),
    text:
      `Dear ${restaurantRecipient},\n\n` +
      `${restaurantParagraphs.join("\n\n")}\n\n` +
      `Vendor: ${vendor.name}\n` +
      `Created by: ${options.createdByName}\n\n` +
      `Next steps:\n` +
      `${restaurantNextSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n` +
      `Sign in: ${restaurantLoginUrl}\n`,
  });
}
