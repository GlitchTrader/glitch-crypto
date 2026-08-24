const SENSITIVE_KEY = /(?:api[_-]?key|secret|signature|listen[_-]?key|authorization|cookie|token|passphrase)/i;
const SENSITIVE_QUERY_VALUE = /((?:api[_-]?key|secret|signature|listen[_-]?key|token|passphrase)=)[^&\s]+/gi;

export function redactProviderEvidence(
  value: unknown,
  forbiddenValues: readonly string[] = [],
): unknown {
  return redactValue(value, forbiddenValues.filter((item) => item.length > 0), new WeakSet<object>());
}

export function assertProviderEvidenceIsSecretFree(
  value: unknown,
  forbiddenValues: readonly string[],
): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of forbiddenValues) {
    if (forbidden && serialized.includes(forbidden)) {
      throw new Error("provider evidence contained a configured credential");
    }
  }
}

function redactValue(
  value: unknown,
  forbiddenValues: readonly string[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return redactString(value, forbiddenValues);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, forbiddenValues, seen));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY.test(key)
      ? "[REDACTED]"
      : redactValue(item, forbiddenValues, seen);
  }
  seen.delete(value);
  return output;
}

function redactString(value: string, forbiddenValues: readonly string[]): string {
  let result = value.replace(SENSITIVE_QUERY_VALUE, "$1[REDACTED]");
  for (const forbidden of forbiddenValues) {
    result = result.split(forbidden).join("[REDACTED]");
  }
  return result;
}
