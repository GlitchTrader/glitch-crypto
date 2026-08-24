import { readFileSync } from "node:fs";

const baseUrl = (process.env.GLITCH_GATEWAY_URL ?? "http://127.0.0.1:8791").replace(/\/$/, "");
const modelToken = (process.env.GLITCH_LOCAL_TOKEN ?? "").trim();
const operatorToken = (process.env.GLITCH_OPERATOR_TOKEN ?? "").trim();

const [command, ...args] = process.argv.slice(2);
if (!command) {
  usage();
  process.exitCode = 1;
} else {
  try {
    const result = await execute(command, args);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function execute(command: string, args: string[]): Promise<unknown> {
  switch (command) {
    case "health":
      return request("/health", "GET", undefined, "none");
    case "status":
      return request("/state", "GET");
    case "packet":
      return request("/packet", "GET");
    case "policy":
      return request("/policy", "GET");
    case "pnl":
      return request("/performance", "GET");
    case "trades":
      return request(`/trades?limit=${integerArg(args[0] ?? "100")}`, "GET");
    case "journal":
      return request(`/journal?limit=${integerArg(args[0] ?? "100")}`, "GET");
    case "start":
      return request("/control/start", "POST", {}, "operator");
    case "stop":
      return request("/control/stop", "POST", {}, "operator");
    case "flatten":
      return request("/control/flatten", "POST", { reason: args.join(" ") || "operator_cli" }, "operator");
    case "set-lock":
      return request(
        "/control/policy",
        "PUT",
        { daily_lock_target_pct: positiveArg(args[0], "daily lock percentage") },
        "operator",
      );
    case "set-usable-limit":
      return request(
        "/control/policy",
        "PUT",
        { usable_balance_limit_usd: positiveArg(args[0], "usable balance limit") },
        "operator",
      );
    case "clear-usable-limit":
      return request(
        "/control/policy",
        "PUT",
        { usable_balance_limit_usd: null },
        "operator",
      );
    case "set-mode":
      return request(
        "/control/mode",
        "PUT",
        { gateway_mode: requiredArg(args[0], "gateway mode") },
        "operator",
      );
    case "paper-price":
      return request(
        "/paper/mark",
        "POST",
        { mark_price: positiveArg(args[0], "mark price") },
        "operator",
      );
    case "intent": {
      const path = requiredArg(args[0], "intent JSON file");
      return request("/intent", "POST", JSON.parse(readFileSync(path, "utf8")) as unknown);
    }
    default:
      usage();
      throw new Error(`unknown command: ${command}`);
  }
}

async function request(
  path: string,
  method: string,
  body?: unknown,
  auth: "model" | "operator" | "none" = "model",
): Promise<unknown> {
  const token = auth === "operator" ? operatorToken : modelToken;
  if (auth !== "none" && token.length < 16) {
    throw new Error(auth === "operator" ? "GLITCH_OPERATOR_TOKEN is not configured" : "GLITCH_LOCAL_TOKEN is not configured");
  }
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      Accept: "application/json",
      ...(auth === "none" ? {} : { Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json() as unknown;
  if (!response.ok) {
    throw new Error(`gateway returned ${response.status}: ${JSON.stringify(value)}`);
  }
  return value;
}

function requiredArg(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveArg(value: string | undefined, name: string): number {
  const parsed = Number(requiredArg(value, name));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be positive`);
  }
  return parsed;
}

function integerArg(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("limit must be a positive integer");
  }
  return parsed;
}

function usage(): void {
  console.log(`Usage: npm run cli -- <command> [args]\n\nCommands:\n  health\n  status\n  packet\n  policy\n  pnl\n  trades [limit]\n  journal [limit]\n  start\n  stop\n  flatten [reason]\n  set-lock <percent>\n  set-usable-limit <usd>\n  clear-usable-limit\n  set-mode <disabled|shadow|armed>\n  paper-price <usd>\n  intent <path.json>`);
}
