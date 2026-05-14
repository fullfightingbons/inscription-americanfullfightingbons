const TABLE_SCHEMAS = {
  audit_logs: ["id", "user_id", "action", "entity_type", "entity_id", "details", "ip", "created_at"],
};

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return Response.json(data, {
    status: init.status || 200,
    headers,
  });
}

function badRequest(message, status = 400) {
  return json({ error: message }, { status });
}

function normalizeRow(table, row) {
  const allowed = new Set(TABLE_SCHEMAS[table] || []);
  if (!allowed.size) {
    return row || {};
  }
  return Object.fromEntries(
    Object.entries(row || {}).filter(([key]) => allowed.has(key)),
  );
}

export {
  badRequest,
  json,
  normalizeRow,
};
