import { z, ZodError } from "zod";
import { fromZodError } from "zod-validation-error";
import { insertContactSubmissionSchema } from "../../db/schema.js";
import { recordPortalActivityAsync } from "../../lib/activity/portal-activity.js";
import { storage } from "../../services/storage.js";
import type { CompatExpressApp, CompatRequest, CompatResponse } from "../../lib/express-compat.js";

const contactBodySchema = insertContactSubmissionSchema.extend({
  website: z.string().optional(),
});

function parseContactBody(req: CompatRequest, res: CompatResponse) {
  try {
    return contactBodySchema.parse(req.body);
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(422).json({
        status: "error",
        message: "Validation failed.",
        errors: fromZodError(error).message,
      });
      return null;
    }
    res.status(400).json({ status: "error", message: "Invalid request body." });
    return null;
  }
}

export function registerContactRoutes(app: CompatExpressApp) {
  app.post("/api/contact", async (req, res) => {
    const body = parseContactBody(req, res);
    if (!body) return;

    if (body.website?.trim()) {
      res.json({ status: "ok", message: "Thank you for your message." });
      return;
    }

    try {
      const submission = await storage.createContactSubmission({
        name: body.name.trim(),
        email: body.email.trim().toLowerCase(),
        message: body.message.trim(),
      });

      recordPortalActivityAsync({
        action: "contact_submitted",
        entityType: "contact_submission",
        entityId: submission.id,
        entityName: `${submission.name} — ${submission.email}`,
        metadata: {
          name: submission.name,
          email: submission.email,
          message: submission.message,
          othersMessage: `New contact inquiry from ${submission.name} (${submission.email})`,
        },
      });

      res.status(201).json({
        status: "ok",
        message: "Thank you for your message. We will get back to you soon.",
        id: submission.id,
      });
    } catch (err) {
      console.error("[contact] submission failed", err);
      res.status(500).json({ status: "error", message: "Could not submit your message. Please try again." });
    }
  });

  app.get("/api/admin/contact-submissions/:id", async (req, res) => {
    try {
      const submission = await storage.getContactSubmission(req.params.id);
      if (!submission) {
        res.status(404).json({ status: "error", message: "Contact inquiry not found." });
        return;
      }
      res.json(submission);
    } catch (err) {
      console.error("[contact] fetch failed", err);
      res.status(500).json({ status: "error", message: "Could not load contact inquiry." });
    }
  });
}
