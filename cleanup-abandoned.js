import { normalizeRow } from "./data.js";
import { isMissingSchemaError } from "./auth.js";

function createAuditId() {
  return crypto.randomUUID();
}

function getClientIp(request) {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "";
}

async function writeAuditLog(db, entry = {}) {
  const row = normalizeRow("audit_logs", {
    id: createAuditId(),
    user_id: entry.userId || null,
    action: entry.action || "unknown",
    entity_type: entry.entityType || null,
    entity_id: entry.entityId || null,
    details: entry.details ? JSON.stringify(entry.details) : null,
    ip: entry.ip || "",
    created_at: new Date().toISOString(),
  });
  const columns = Object.keys(row);
  try {
    await db.prepare(
      `INSERT INTO "audit_logs" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).bind(...columns.map((column) => row[column])).run();
  } catch (error) {
    if (!isMissingSchemaError(error)) {
      throw error;
    }
  }
}

export {
  getClientIp,
  writeAuditLog,
};
