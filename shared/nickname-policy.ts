export const NICKNAME_MAX_LENGTH = 64;

export type NicknameValidationErrorCode = "too_long" | "invalid_chars" | "forbidden";

export interface NicknameValidationResult {
  ok: boolean;
  code?: NicknameValidationErrorCode;
  message?: string;
}

const FORBIDDEN_ASCII_SUBSTRINGS = [
  "root",
  "admin",
  "administrator",
  "sysadmin",
  "superadmin",
  "superuser",
  "webmaster",
  "postmaster",
  "hostmaster",
  "sysop",
  "moderator",
  "supervisor",
  "system",
  "daemon",
  "noreply",
  "donotreply",
  "donebot",
  "openmaus",
  "opengrokbot",
  "sub2api",
  "official",
  "guanfang",
  "botmarket",
  "botstore",
  "marketplace",
  "support",
  "helpdesk",
  "customerservice",
  "custservice",
  "helpcenter",
  "security",
  "antifraud",
  "compliance",
  "verified",
  "billing",
  "payment",
  "finance",
  "kefu",
  "guanliyuan",
  "guanli",
  "xitong",
  "yunying",
  "yunwei",
  "shenhe",
  "fengkong",
] as const;

const FORBIDDEN_CJK_SUBSTRINGS = [
  "管理员",
  "超管",
  "超级管理",
  "总管",
  "系统管理",
  "后台管理",
  "站长",
  "版主",
  "网管",
  "管理者",
  "官方",
  "官微",
  "官号",
  "官博",
  "官服",
  "正版授权",
  "认证账号",
  "认证账户",
  "认证号",
  "蓝v",
  "内部人员",
  "内部员工",
  "内部号",
  "内部渠道",
  "平台方",
  "平台账号",
  "平台账户",
  "平台助手",
  "平台服务",
  "主办方",
  "运营方",
  "开发团队",
  "研发团队",
  "技术团队",
  "产品团队",
  "核心团队",
  "创始团队",
  "创始人",
  "联合创始人",
  "项目组",
  "工作组",
  "总部",
  "总裁办",
  "服务号",
  "公众号",
  "系统",
  "通知中心",
  "安全中心",
  "风控",
  "审核",
  "审查",
  "质检",
  "合规",
  "运维",
  "运营",
  "封号",
  "解封",
  "申诉",
  "黑名单",
  "实名认证",
  "身份验证",
  "验证码",
  "客服",
  "售后",
  "客诉",
  "人工服务",
  "服务台",
  "帮助中心",
  "技术支持",
  "服务支持",
  "用户支持",
  "店小二",
  "值班",
  "安全专员",
  "反诈",
  "反欺诈",
  "防骗",
  "财务",
  "结算",
  "充值",
  "支付",
  "账单",
  "提现",
  "收银台",
  "计费",
  "算力中心",
  "代充",
  "返利",
  "刷单",
  "中奖",
  "领奖",
  "派奖",
  "法务",
  "仲裁",
  "公安",
  "警察",
  "网警",
  "民警",
  "交警",
  "法院",
  "检察院",
  "税务",
  "工商",
  "监管",
  "网信办",
  "工信部",
  "证监会",
  "银保监",
  "央行",
  "人民政府",
  "国务院",
  "外交部",
  "新华社",
  "人民日报",
  "央视",
  "权威发布",
] as const;

const FORBIDDEN_ASCII_TOKENS = new Set([
  "su",
  "sudo",
  "wheel",
  "mod",
  "mods",
  "gm",
  "ops",
  "devops",
]);

const FORBIDDEN_EXACT = new Set([
  "owner",
  "master",
  "bot",
  "team",
  "staff",
  "service",
  "verify",
  "auth",
  "server",
  "localhost",
  "guest",
  "anonymous",
  "null",
  "undefined",
  "none",
  "unknown",
  "founder",
  "平台",
  "团队",
  "助手",
  "小助手",
  "机器人",
  "匿名",
  "游客",
  "未命名",
  "未知",
]);

const ZERO_WIDTH_OR_FORMAT = /\p{Cf}|[\u00AD\u200B-\u200F\u2060\uFEFF]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function foldFullwidth(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code === 0x3000) return " ";
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
  return ch;
}

function mapLeet(ch: string): string {
  switch (ch) {
    case "0": return "o";
    case "1":
    case "!": return "i";
    case "3": return "e";
    case "4":
    case "@": return "a";
    case "5":
    case "$": return "s";
    case "7": return "t";
    case "8": return "b";
    default: return ch;
  }
}

export function validateUserNickname(raw: string): NicknameValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true };

  const chars = Array.from(trimmed);
  if (chars.length > NICKNAME_MAX_LENGTH) {
    return { ok: false, code: "too_long", message: `昵称最多 ${NICKNAME_MAX_LENGTH} 个字符。` };
  }

  let compact = "";
  let leetCompact = "";
  const asciiTokens: string[] = [];
  let curToken = "";

  const flushToken = () => {
    if (curToken) {
      asciiTokens.push(curToken);
      curToken = "";
    }
  };

  for (const ch of chars) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return { ok: false, code: "invalid_chars", message: "昵称不能包含控制字符或换行。" };
    }
    if (ZERO_WIDTH_OR_FORMAT.test(ch)) continue;

    const folded = foldFullwidth(ch).toLowerCase();
    if ((folded >= "a" && folded <= "z") || (folded >= "0" && folded <= "9")) {
      curToken += folded;
    } else {
      flushToken();
    }

    if (LETTER_OR_DIGIT.test(folded)) {
      compact += folded;
    }

    const leet = mapLeet(folded);
    if (LETTER_OR_DIGIT.test(leet)) {
      leetCompact += leet;
    }
  }
  flushToken();

  if (!compact) {
    return { ok: false, code: "forbidden", message: "昵称不能仅包含符号，请使用易识别的正常昵称。" };
  }

  const forbiddenMsg = "昵称包含受限制或易产生误解的词汇（如官方、管理员、客服、系统等），请更换其他昵称。";
  if (FORBIDDEN_EXACT.has(compact)) {
    return { ok: false, code: "forbidden", message: forbiddenMsg };
  }
  for (const tok of asciiTokens) {
    if (FORBIDDEN_ASCII_TOKENS.has(tok)) {
      return { ok: false, code: "forbidden", message: forbiddenMsg };
    }
  }
  for (const word of FORBIDDEN_ASCII_SUBSTRINGS) {
    if (compact.includes(word) || leetCompact.includes(word)) {
      return { ok: false, code: "forbidden", message: forbiddenMsg };
    }
  }
  for (const word of FORBIDDEN_CJK_SUBSTRINGS) {
    if (compact.includes(word)) {
      return { ok: false, code: "forbidden", message: forbiddenMsg };
    }
  }
  return { ok: true };
}
