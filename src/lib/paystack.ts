import crypto from "crypto";
import fs from "fs";
import path from "path";

export interface InitializePaystackParams {
  email: string;
  amountMinor: number; // In minor units, e.g. kobo (500000 = 5,000 NGN)
  currency: string;
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface InitializePaystackResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export interface PaystackTransactionData {
  id: number;
  domain: string; // "test" or "live"
  status: string; // e.g. "success", "failed", "abandoned"
  reference: string;
  amount: number; // in minor units
  message: string | null;
  gateway_response: string;
  paid_at: string | null;
  created_at: string;
  channel: string;
  currency: string;
  ip_address: string;
  metadata?: Record<string, unknown> | null;
  customer?: {
    id: number;
    email: string;
    customer_code: string;
  } | null;
  authorization?: {
    authorization_code?: string;
    bin?: string;
    last4?: string;
    exp_month?: string;
    exp_year?: string;
    channel?: string;
    card_type?: string;
    bank?: string;
    country_code?: string;
    brand?: string;
    reusable?: boolean;
    signature?: string;
  } | null;
}

export interface VerifyPaystackResult {
  status: boolean;
  message: string;
  data: PaystackTransactionData;
}

/**
 * Validates and retrieves the Paystack secret key from environment variables.
 * Enforces test mode strictly: keys MUST begin with 'sk_test_'.
 */
export function getPaystackSecretKey(): string {
  let secretKey = process.env.PAYSTACK_SECRET_KEY;

  if (!secretKey) {
    try {
      const envPath = path.join(process.cwd(), ".env");
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, "utf-8");
        const match = envContent.match(/^PAYSTACK_SECRET_KEY=(.*)$/m);
        if (match && match[1]) {
          secretKey = match[1].trim().replace(/^["']|["']$/g, "").trim();
          process.env.PAYSTACK_SECRET_KEY = secretKey;
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  if (secretKey) {
    secretKey = secretKey.trim().replace(/^["']|["']$/g, "").trim();
  }

  if (!secretKey) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured in environment variables.");
  }

  if (!secretKey.startsWith("sk_test_")) {
    throw new Error(
      "Paystack is restricted to test mode only. Secret key must begin with 'sk_test_'."
    );
  }

  return secretKey;
}

/**
 * Generates a unique, cryptographically random reference for checkout initiation.
 * Format adheres to Paystack requirements: only alphanumeric characters plus -, . or = (no underscores).
 */
export function generateCheckoutReference(prefix = "pstk"): string {
  const timestamp = Date.now();
  const randomHex = crypto.randomBytes(8).toString("hex");
  return `${prefix}-${timestamp}-${randomHex}`;
}

/**
 * Initiates a real hosted checkout transaction with Paystack's test-mode API.
 * Calls Paystack's transaction initialization endpoint and extracts the real authorization_url.
 * No mock or simulated URLs are generated.
 */
export async function initializePaystackTransaction(
  params: InitializePaystackParams
): Promise<InitializePaystackResult> {
  const secretKey = getPaystackSecretKey();

  const payload: Record<string, unknown> = {
    email: params.email,
    amount: params.amountMinor,
    currency: params.currency,
    reference: params.reference,
  };

  if (params.callbackUrl) {
    payload.callback_url = params.callbackUrl;
  }

  if (params.metadata) {
    payload.metadata = params.metadata;
  }

  let response: Response;
  try {
    response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (networkError) {
    const errorMsg =
      networkError instanceof Error ? networkError.message : "Network request failed";
    throw new Error(`Failed to reach Paystack API: ${errorMsg}`);
  }

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.status) {
    const message = data?.message || `HTTP ${response.status} ${response.statusText}`;
    if (response.status === 401) {
      throw new Error(
        `Paystack API authentication failed (401): ${message}. Please verify that PAYSTACK_SECRET_KEY is a valid test secret key (sk_test_...).`
      );
    }
    throw new Error(`Paystack transaction initialization failed: ${message}`);
  }

  const authorizationUrl = data?.data?.authorization_url;
  if (!authorizationUrl) {
    throw new Error(
      "Paystack transaction initialization succeeded but returned no authorization_url."
    );
  }

  return {
    authorizationUrl,
    accessCode: data.data.access_code,
    reference: data.data.reference || params.reference,
  };
}

/**
 * Verifies a transaction status with Paystack's server API:
 * GET https://api.paystack.co/transaction/verify/:reference
 */
export async function verifyPaystackTransaction(
  reference: string
): Promise<VerifyPaystackResult> {
  const secretKey = getPaystackSecretKey();

  let response: Response;
  try {
    response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          Accept: "application/json",
        },
      }
    );
  } catch (networkError) {
    const errorMsg =
      networkError instanceof Error ? networkError.message : "Network request failed";
    throw new Error(`Failed to reach Paystack API for verification: ${errorMsg}`);
  }

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.status) {
    const message = data?.message || `HTTP ${response.status} ${response.statusText}`;
    if (response.status === 401) {
      throw new Error(
        `Paystack API authentication failed (401): ${message}. Please verify that PAYSTACK_SECRET_KEY is a valid test secret key (sk_test_...).`
      );
    }
    throw new Error(`Paystack transaction verification failed: ${message}`);
  }

  return data as VerifyPaystackResult;
}

/**
 * Verifies the HMAC SHA512 signature of an incoming Paystack webhook payload.
 * Uses timingSafeEqual to protect against timing attacks.
 */
export function verifyPaystackSignature(rawBody: string, signature: string | null): boolean {
  if (!signature || !rawBody) {
    return false;
  }

  try {
    const secretKey = getPaystackSecretKey();
    const expectedHash = crypto
      .createHmac("sha512", secretKey)
      .update(rawBody)
      .digest("hex");

    const signatureBuffer = Buffer.from(signature.trim(), "hex");
    const expectedBuffer = Buffer.from(expectedHash, "hex");

    if (signatureBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch {
    return false;
  }
}
