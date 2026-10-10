import { Resend } from "resend";
import { isEmailEnabled, getEmailFromAddress } from "./settings";

// Lazy initialization of Resend client
let resendClient: Resend | null = null;

function getResendClient(): Resend {
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

/** For logs: Resend's error messages can quote the address they rejected */
function redact(value: unknown): string {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").replace(/[^\s@"'<>,;]+@[^\s@"'<>,;]+/g, "<address>");
}

type ResendError = { name: string; message: string };
type ResendCall<T> = { data: T | null; error: ResendError | null };

// Failures where Resend may not have taken the request, so the same call is tried again. With an
// idempotency key Resend sends it at most once, so a retry after a lost response can't duplicate it.
// Quota errors aren't retried: they won't clear for hours.
const RETRYABLE_ERRORS = new Set(["application_error", "internal_server_error", "rate_limit_exceeded", "concurrent_idempotent_requests"]);
export const RETRY_DELAYS_MS = [1000, 3000];

async function withRetries<T>(call: () => Promise<ResendCall<T>>): Promise<ResendCall<T>> {
  const attempt = async (): Promise<ResendCall<T>> => {
    try {
      return await call();
    } catch (error) {
      // The SDK normally reports network failures as application_error; treat a throw the same way
      return { data: null, error: { name: "application_error", message: String(error) } };
    }
  };
  let result = await attempt();
  for (const delay of RETRY_DELAYS_MS) {
    if (!result.error || !RETRYABLE_ERRORS.has(result.error.name)) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    result = await attempt();
  }
  return result;
}

export type SendEmailParams = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
};

export type SendEmailResult = {
  success: boolean;
  messageId?: string;
  error?: string;
};

/**
 * Send an email via Resend.
 * Respects the global email enabled setting. Pass an idempotency key that's unique to this attempt
 * so transient failures can be retried without sending twice.
 */
export async function sendEmail(
  { to, subject, html, text, replyTo }: SendEmailParams,
  options: { idempotencyKey?: string } = {}
): Promise<SendEmailResult> {
  // Check if email is enabled globally
  const enabled = await isEmailEnabled();
  if (!enabled) {
    // Never log the recipient: addresses don't belong in the function logs
    console.log("[Email] System disabled, skipping:", subject);
    return { success: false, error: "Email system disabled" };
  }

  // Check if API key is configured
  if (!process.env.RESEND_API_KEY) {
    console.error("[Email] RESEND_API_KEY not configured");
    return { success: false, error: "Email service not configured" };
  }

  const from = await getEmailFromAddress();
  const resend = getResendClient();
  const result = await withRetries(() =>
    resend.emails.send({ from, to, subject, html, text, replyTo }, { idempotencyKey: options.idempotencyKey })
  );

  if (result.error || !result.data) {
    console.error("[Email] Send failed:", redact(result.error));
    return { success: false, error: result.error?.message ?? "Send failed" };
  }

  console.log("[Email] Sent:", result.data.id);
  return { success: true, messageId: result.data.id };
}

/** Resend's batch endpoint takes at most this many emails per call. */
export const MAX_BATCH_EMAILS = 100;

/**
 * Send up to MAX_BATCH_EMAILS emails in one Resend call. Returns one result per email, in order.
 * Permissive validation: an email Resend rejects (e.g. a bad address) fails on its own instead of
 * sinking the whole batch. Pass an idempotency key unique to this batch so retries can't duplicate it.
 */
export async function sendBatchEmails(
  emails: Array<Omit<SendEmailParams, "replyTo">>,
  options: { idempotencyKey?: string } = {}
): Promise<SendEmailResult[]> {
  if (emails.length > MAX_BATCH_EMAILS) {
    throw new Error(`sendBatchEmails takes at most ${MAX_BATCH_EMAILS} emails, got ${emails.length}`);
  }
  const enabled = await isEmailEnabled();
  if (!enabled) {
    console.log("[Email] System disabled, skipping batch of", emails.length);
    return emails.map(() => ({ success: false, error: "Email system disabled" }));
  }

  if (!process.env.RESEND_API_KEY) {
    console.error("[Email] RESEND_API_KEY not configured");
    return emails.map(() => ({ success: false, error: "Email service not configured" }));
  }

  const from = await getEmailFromAddress();
  const resend = getResendClient();
  const payload = emails.map((email) => ({ from, to: email.to, subject: email.subject, html: email.html, text: email.text }));
  const result = await withRetries(() =>
    resend.batch.send(payload, { batchValidation: "permissive", idempotencyKey: options.idempotencyKey })
  );

  if (result.error || !result.data) {
    console.error("[Email] Batch send failed:", redact(result.error));
    return emails.map(() => ({ success: false, error: result.error?.message ?? "Batch send failed" }));
  }

  // `data` lists the accepted emails in order; `errors` names the rejected ones by index
  const rejected = new Map((result.data.errors ?? []).map((e) => [e.index, e.message]));
  const ids = result.data.data ?? [];
  if (ids.length !== emails.length - rejected.size) {
    console.error(`[Email] Batch returned ${ids.length} ids for ${emails.length - rejected.size} accepted emails`);
  }
  let next = 0;
  const results = emails.map((_, index): SendEmailResult => {
    const error = rejected.get(index);
    if (error !== undefined) return { success: false, error };
    return { success: true, messageId: ids[next++]?.id };
  });

  console.log(`[Email] Batch sent: ${emails.length - rejected.size} of ${emails.length}`);
  if (rejected.size) console.error("[Email] Batch rejected:", [...rejected.values()].map(redact));
  return results;
}
