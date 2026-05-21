import test from "node:test";
import assert from "node:assert/strict";

import {
  computeHmacHex,
  getRegistrationIdFromNotification,
  verifyHelloAssoNotification,
} from "../src/routes/api/public/payment/helloasso/notification-helpers.js";

test("verifyHelloAssoNotification accepts valid HMAC signature", async () => {
  const rawBody = JSON.stringify({ eventType: "Payment" });
  const secret = "topsecret";
  const signature = await computeHmacHex(rawBody, secret);
  const request = new Request("https://example.test/webhook", {
    method: "POST",
    headers: {
      "x-ha-signature": signature,
      "cf-connecting-ip": "203.0.113.1",
    },
  });

  const valid = await verifyHelloAssoNotification(request, rawBody, {
    HELLOASSO_ENV: "production",
    HELLOASSO_NOTIFICATION_SIGNATURE_KEY: secret,
  });

  assert.equal(valid, true);
});

test("verifyHelloAssoNotification rejects production requests without signature key", async () => {
  const request = new Request("https://example.test/webhook", {
    method: "POST",
    headers: {
      "cf-connecting-ip": "51.138.206.200",
    },
  });

  const valid = await verifyHelloAssoNotification(request, "{}", {
    HELLOASSO_ENV: "production",
    HELLOASSO_NOTIFICATION_SIGNATURE_KEY: "",
  });

  assert.equal(valid, false);
});

test("verifyHelloAssoNotification allows sandbox IP fallback", async () => {
  const request = new Request("https://example.test/webhook", {
    method: "POST",
    headers: {
      "cf-connecting-ip": "4.233.135.234",
    },
  });

  const valid = await verifyHelloAssoNotification(request, "{}", {
    HELLOASSO_ENV: "sandbox",
    HELLOASSO_NOTIFICATION_SIGNATURE_KEY: "",
  });

  assert.equal(valid, true);
});

test("getRegistrationIdFromNotification extracts nested metadata", () => {
  const payload = {
    data: {
      order: {
        metadata: { registrationId: "reg_123" },
      },
    },
  };

  assert.equal(getRegistrationIdFromNotification(payload), "reg_123");
});
