import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { DoneBotGatewayError, type DoneBotGateway } from "./gateway.ts";
import type { DoneBotCloudMutation } from "../../shared/donebot-cloud.ts";
import { createPaymentOrder, paymentOrder, paymentSnapshot } from "./payments.ts";
import type { DoneBotPaymentInput } from "../../shared/donebot-payments.ts";
import { parseTeamCloudMutation, parseTeamDeviceCommand, teamCommand } from "./teams.ts";

const proofKeys = ["turnstile_token", "captcha_token", "captcha_ticket", "captcha_randstr", "captcha_verify_param", "tencent_ticket", "tencent_randstr", "tencent_captcha_ticket", "tencent_captcha_randstr", "aliyun_captcha_verify_param"];
function text(body: Record<string, unknown>, key: string, max = 1000): string {
  const value = body[key];
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > max) throw new DoneBotGatewayError(400, "invalid_input", `Invalid ${key}.`);
  return value;
}
function proofs(body: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(proofKeys.filter(key => body[key] !== undefined).map(key => [key, text(body, key, 8192)]));
}
export function createDoneBotAccountRoutes(gateway: DoneBotGateway): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/donebot/")) return PASS;
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only the workspace owner can manage the DoneBot account." });
    res.setHeader("Cache-Control", "no-store");
    try {
      if (process.env.DONEBOT_TEAM_RUNTIME === "1" && path !== "/api/donebot/catalog") return json(res, 403, { error: "个人账号与账单只能在个人工作空间管理。" });
      if (method === "GET" && path === "/api/donebot/state") return json(res, 200, gateway.state());
      if (method === "GET" && path === "/api/donebot/settings") return json(res, 200, await gateway.publicSettings());
      if (method === "GET" && path === "/api/donebot/account") return json(res, 200, await gateway.account());
      if (method === "GET" && path === "/api/donebot/catalog") return json(res, 200, await gateway.refreshCatalog());
      if (method === "GET" && path === "/api/donebot/cloud") return json(res, 200, await gateway.cloudSnapshot());
      if (method === "GET" && path === "/api/donebot/workspaces") return json(res, 200, await gateway.workspaceSnapshot());
      if (method === "GET" && path === "/api/donebot/teams/plans") return json(res, 200, await gateway.teamPlans());
      const members = path.match(/^\/api\/donebot\/teams\/([a-f0-9-]{36})\/members$/);
      if (method === "GET" && members) return json(res, 200, await gateway.teamMembers(members[1]!));
      const teamCloudGet = path.match(/^\/api\/donebot\/teams\/([a-f0-9-]{36})\/cloud$/);
      if (method === "GET" && teamCloudGet) return json(res, 200, await gateway.teamCloud(teamCloudGet[1]!));
      const teamDevicesGet = path.match(/^\/api\/donebot\/teams\/([a-f0-9-]{36})\/devices$/);
      if (method === "GET" && teamDevicesGet) return json(res, 200, await gateway.teamDevices(teamDevicesGet[1]!));
      if (method === "GET" && path === "/api/donebot/payments") return json(res, 200, await paymentSnapshot(gateway));
      if (method !== "POST") return PASS;
      if (process.env.DONEBOT_CLOUD_CREDENTIAL_FILE) return json(res, 403, { error: "请在 DoneBot Cloud 控制台管理此账号。" });
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new DoneBotGatewayError(400, "invalid_input", "Expected an account JSON object.");
      if (path === "/api/donebot/teams") {
        const parsed = teamCommand.safeParse(body);
        if (!parsed.success) throw new DoneBotGatewayError(400, "invalid_input", "无效的团队操作。");
        return json(res, 200, await gateway.teamMutate(parsed.data));
      }
      const teamCloudPost = path.match(/^\/api\/donebot\/teams\/([a-f0-9-]{36})\/cloud$/);
      if (teamCloudPost) {
        let parsed;
        try { parsed = parseTeamCloudMutation(body); } catch { throw new DoneBotGatewayError(400, "invalid_input", "无效的团队 Cloud 操作。"); }
        return json(res, 202, await gateway.teamCloudMutate(teamCloudPost[1]!, parsed));
      }
      const teamCloudConnect = path.match(/^\/api\/donebot\/teams\/([a-f0-9-]{36})\/cloud\/connect$/);
      if (teamCloudConnect) {
        if (Object.keys(body).some(key => !["instance_id", "account_id"].includes(key))) throw new DoneBotGatewayError(400, "invalid_input", "无效的团队 Cloud 连接字段。");
        return json(res, 200, await gateway.teamCloudConnect(teamCloudConnect[1]!, text(body, "instance_id", 36), text(body, "account_id", 200)));
      }
      const teamDevicesPost = path.match(/^\/api\/donebot\/teams\/([a-f0-9-]{36})\/devices$/);
      if (teamDevicesPost) {
        let parsed;
        try { parsed = parseTeamDeviceCommand(body); } catch { throw new DoneBotGatewayError(400, "invalid_input", "无效的团队设备操作。"); }
        return json(res, 200, await gateway.teamDeviceMutate(teamDevicesPost[1]!, parsed));
      }
      if (path === "/api/donebot/payments/orders") {
        if (Object.keys(body).some(key => !["account_id", "amount", "payment_type"].includes(key)) || typeof body.amount !== "number") throw new DoneBotGatewayError(400, "payment_input", "无效的充值订单。");
        return json(res, 201, await createPaymentOrder(gateway, { account_id: text(body, "account_id", 200), amount: body.amount,
          payment_type: text(body, "payment_type", 20) as DoneBotPaymentInput["payment_type"] }));
      }
      const payment = path.match(/^\/api\/donebot\/payments\/orders\/([1-9]\d{0,14})\/(status|verify|cancel)$/);
      if (payment) {
        if (Object.keys(body).some(key => key !== "account_id")) throw new DoneBotGatewayError(400, "payment_input", "无效的充值操作。");
        const accountID = text(body, "account_id", 200), orderPath = `orders/${payment[1]}`;
        if (payment[2] === "cancel") await gateway.paymentRequest(`${orderPath}/cancel`, {}, accountID);
        const order = paymentOrder(await gateway.paymentRequest(orderPath, undefined, accountID));
        return json(res, 200, payment[2] === "verify" ? paymentOrder(await gateway.paymentRequest("orders/verify", { out_trade_no: order.out_trade_no }, accountID)) : order);
      }
      if (path === "/api/donebot/cloud") {
        if (Object.keys(body).some(key => !["id", "action", "key", "account_id", "monthly_price"].includes(key))) throw new DoneBotGatewayError(400, "invalid_input", "Invalid Cloud fields.");
        return json(res, 202, await gateway.cloudMutate({ id: text(body, "id", 36) || undefined, action: text(body, "action", 10) as DoneBotCloudMutation["action"],
          key: text(body, "key", 100), account_id: text(body, "account_id", 200), monthly_price: text(body, "monthly_price", 100) }));
      }
      if (path === "/api/donebot/cloud/connect") {
        if (Object.keys(body).some(key => !["id", "account_id"].includes(key)) || !text(body, "account_id", 200)) throw new DoneBotGatewayError(400, "invalid_input", "Invalid Cloud connection fields.");
        return json(res, 200, await gateway.cloudConnect(text(body, "id", 36), text(body, "account_id", 200)));
      }
      if (path === "/api/donebot/verification") return json(res, 200, await gateway.sendVerification(text(body, "email", 320).trim(), proofs(body)));
      if (path === "/api/donebot/forgot-password") return json(res, 200, await gateway.forgotPassword(text(body, "email", 320).trim(), proofs(body)));
      if (path === "/api/donebot/reset-password") {
        const code = text(body, "email_code", 6), password = text(body, "new_password");
        if (!/^\d{6}$/.test(code) || password.length < 6) throw new DoneBotGatewayError(400, "invalid_input", "Enter a six-digit code and a password of at least six characters.");
        await gateway.resetPassword(text(body, "email", 320).trim(), code, password);
        return json(res, 200, { message: "Password updated. Sign in with your new password." });
      }
      if (path === "/api/donebot/login") return json(res, 200, await gateway.login(text(body, "email", 320).trim(), text(body, "password"), proofs(body)));
      if (path === "/api/donebot/register") return json(res, 200, await gateway.register({ ...proofs(body), email: text(body, "email", 320).trim(), password: text(body, "password"), verify_code: text(body, "verify_code", 32), invitation_code: text(body, "invitation_code", 100), promo_code: text(body, "promo_code", 100) }));
      if (path === "/api/donebot/2fa") return json(res, 200, await gateway.verify2fa(text(body, "totp_code", 32)));
      if (path === "/api/donebot/cancel-login") return json(res, 200, gateway.cancelLogin());
      if (path === "/api/donebot/logout") { await gateway.logout(); return json(res, 200, gateway.state()); }
      return PASS;
    } catch (error) {
      if (error instanceof DoneBotGatewayError) return json(res, error.status, { error: error.message, code: error.code });
      return json(res, 502, { error: "DoneBot could not complete this request. Please retry." });
    }
  };
}
