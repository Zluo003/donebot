import { describe, expect, it } from "vitest";
import { NICKNAME_MAX_LENGTH, validateUserNickname } from "./nickname-policy";

describe("validateUserNickname", () => {
  it("allows empty and normal creator nicknames", () => {
    for (const name of [
      "",
      "   ",
      "老罗",
      "阿泽",
      "Product Lead",
      "Product Owner",
      "Alice Example",
      "码匠",
      "独立站卖家",
      "RobotLover",
      "编程小助手2026",
    ]) {
      expect(validateUserNickname(name).ok, name).toBe(true);
    }
  });

  it("rejects reserved, official, admin, support and obfuscated impersonation nicknames", () => {
    for (const name of [
      "root",
      "ROOT",
      "r00t",
      "r.o.o.t",
      "admin",
      "ADM1N",
      "@dmin",
      "Ａｄｍｉｎ",
      "administrator",
      "管理员",
      "管 理 员",
      "管\u200b理\u200b员",
      "超级管理员",
      "客服",
      "在线客服",
      "DoneBot",
      "D0neB0t",
      "Done-Bot官方",
      "官方",
      "官·方",
      "official",
      "0ff1c1al",
      "系统通知",
      "安全中心",
      "风控审核",
      "support",
      "helpdesk",
      "moderator",
      "财务结算",
      "充值中心",
      "网警",
      "sudo",
      "mod",
      "owner",
      "bot",
      "平台",
      "小助手",
      "!!!",
      "bad\nname",
    ]) {
      const res = validateUserNickname(name);
      expect(res.ok, name).toBe(false);
      expect(res.message, name).toBeTruthy();
    }
  });

  it("enforces max length", () => {
    expect(validateUserNickname("罗".repeat(NICKNAME_MAX_LENGTH)).ok).toBe(true);
    const over = validateUserNickname("罗".repeat(NICKNAME_MAX_LENGTH + 1));
    expect(over.ok).toBe(false);
    expect(over.code).toBe("too_long");
  });
});
