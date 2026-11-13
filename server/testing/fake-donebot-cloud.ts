import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DoneBotCloudInstance, DoneBotCloudMutationResult, DoneBotCloudOperation } from "../../shared/donebot-cloud.ts";

/** Synthetic billing and worker responses for isolated client wiring verification only. */
export class FakeDoneBotCloud {
  enabled = false;
  balanceCents = 0;
  charges = 0;
  failure = "";
  dropNextReply = false;
  private instance: DoneBotCloudInstance | null = null;
  private operations: DoneBotCloudOperation[] = [];
  private receipts = new Map<string, DoneBotCloudMutationResult>();
  handle(path: string, request: IncomingMessage, response: ServerResponse, loggedIn: boolean): boolean {
    if (!path.startsWith("/api/v1/donebot/cloud/")) return false;
    const send = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ code: 0, data: value })); };
    if (!loggedIn) { send({}, 401); return true; }
    const route = path.slice("/api/v1/donebot/cloud/".length);
    if (request.method === "GET") {
      if (route === "plan") send({ plan: { enabled: this.enabled, monthly_price: "12.500000", retention_days: 7 }, browser_available: true });
      else if (route === "instances") send(this.instance ? [this.instance] : []);
      else if (route === `instances/${this.instance?.id}/operations`) send(this.operations);
      else send({}, 404);
      return true;
    }
    if (route === `instances/${this.instance?.id}/desktop-launch`) {
      send({ url: `donebot://pair?address=${encodeURIComponent(`https://${this.instance!.id}.cloud.example.invalid`)}&token=omb_pair_${"x".repeat(43)}&name=DoneBot%20Cloud` });
      return true;
    }
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key) { send({}, 400); return true; }
    const cached = this.receipts.get(key);
    if (cached) { send(cached, 202); return true; }
    const action = route === "instances" ? "start" : route.split("/").at(-1);
    if (request.method !== "POST" || !["start", "stop", "cancel"].includes(action ?? "")) { send({}, 404); return true; }
    const instance = this.instance ?? { id: randomUUID(), desired: "stopped", actual: "missing", error: "", paid_until: null, subscription_state: "unpaid", purge_locked: false };
    const operation: DoneBotCloudOperation = { id: randomUUID(), action: action!, state: "succeeded", error: "" };
    if (action === "start") {
      const charged = instance.subscription_state === "active" && !!instance.paid_until && Date.parse(instance.paid_until) > Date.now();
      const failure = this.failure || (!charged && this.balanceCents < 1250 ? "billing_insufficient_balance" : "");
      if (failure) {
        instance.actual = "error"; instance.error = failure;
        operation.state = "failed"; operation.error = failure;
      } else {
        if (!charged) { this.balanceCents -= 1250; this.charges++; }
        Object.assign(instance, { desired: "running", actual: "running", error: "", subscription_state: "active", paid_until: new Date(Date.now() + 30 * 86400000).toISOString() });
      }
    } else {
      instance.desired = "stopped"; instance.actual = "stopped";
      if (action === "cancel") instance.subscription_state = "cancelled";
    }
    this.instance = instance; this.operations.unshift(operation);
    const result = structuredClone({ instance, operation });
    this.receipts.set(key, result);
    if (this.dropNextReply) { this.dropNextReply = false; response.destroy(); }
    else send(result, 202);
    return true;
  }
}
