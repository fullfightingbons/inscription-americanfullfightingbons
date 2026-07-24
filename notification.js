function isMissingSchemaError(error) {
  const message = String(error?.message || error || "");
  return /no such table|no such column/i.test(message);
}

export {
  isMissingSchemaError,
};
