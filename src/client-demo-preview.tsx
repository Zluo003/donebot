import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "@/components/ChatView";
import { MausAvatar } from "@/components/Avatar";
import { applySkinChoice } from "@/lib/skins";
import { loadLocale } from "@/lib/i18n";
import { initialState, StoreContext, type AppState, type Bot, type Message } from "@/state/store";
import "./styles.css";

const SCENES = {
  store: {
    label: "独立站团队",
    task: "把 60 条商品评价归纳成购买动机，写一版详情页，再整理团队需要补拍的素材。",
    replies: [
      "我先合并重复反馈，找出用户最在意的购买理由。",
      "归纳出 4 个动机：省空间、单手操作、材质安全、清洁快。",
      "详情页结构和三版标题已整理，6 个拍摄镜头也已同步给团队。",
    ],
  },
  tiktok: {
    label: "TikTok Shop 投放",
    task: "为便携榨汁杯做 3 条不同 Hook 的广告视频，重点突出便携、续航和清洗。",
    replies: [
      "我会按开场、产品演示、卖点证明和行动号召组织镜头。",
      "已写好通勤早餐、健身补给、周末露营 3 套脚本和分镜。",
      "字幕、画面素材与音乐方向已整理成可继续剪辑的版本。",
    ],
  },
  studio: {
    label: "自媒体工作室",
    task: "追踪本周 AI 创作工具动态，找 5 个选题，整理来源，并剪成 60 秒视频。",
    replies: [
      "我在核对官方更新、创作者反馈和引用来源，合并重复信息。",
      "5 个题材已按热度与差异化排序，研究文档附有引用和原始素材。",
      "60 秒剪辑草稿已完成，包含标题、字幕和配乐。",
    ],
  },
} as const;

type Scene = keyof typeof SCENES;
type Stage = "thinking" | "working" | "success";
const params = new URLSearchParams(location.search);
const scene = (params.get("scene") as Scene) in SCENES ? (params.get("scene") as Scene) : "store";
const skin = params.get("skin") === "daylight" ? "daylight" : "midnight";
const layout = params.get("layout") === "phone" ? "phone" : "desktop";
applySkinChoice(skin);
await loadLocale("zh");

const AT = Date.now() - 20_000;
const row = (id: string, index: number, role: "user" | "bot", text: string): Message => ({
  id,
  at: AT + index * 3_500,
  role,
  kind: "text",
  text,
}) as Message;

function Demo() {
  const content = SCENES[scene];
  const [rows, setRows] = useState<Message[]>([row("task", 0, "user", content.task)]);
  const [stage, setStage] = useState<Stage>("thinking");
  const [motionKey, setMotionKey] = useState(0);
  const state = useMemo<AppState>(() => {
    const bot: Bot = {
      id: "donebot-demo",
      name: "DoneBot",
      title: "",
      description: "",
      notifications: true,
      unread: false,
      color: "red",
      mascotBody: "circle",
      modelSelection: { instanceId: "demo" },
      threadId: "donebot-demo-thread",
      mainThreadId: "donebot-demo-thread",
      busy: stage !== "success",
      activity: stage === "success" ? "idle" : "working",
      messages: rows,
    } as Bot;
    return { ...initialState, bots: [bot], selectedId: bot.id, connected: true };
  }, [rows, stage]);

  useEffect(() => {
    let timer = 0;
    const timeouts: number[] = [];
    const play = () => {
      setRows([row("task", 0, "user", content.task)]);
      setStage("thinking");
      setMotionKey((value) => value + 1);
      timer = window.setTimeout(() => {
        setStage("working");
        content.replies.forEach((reply, index) => {
          timeouts.push(window.setTimeout(() => {
            setRows((current) => [...current, row(`reply-${index}`, index + 1, "bot", reply)]);
            if (index === content.replies.length - 1) {
              setStage("success");
              setMotionKey((value) => value + 1);
            }
          }, index * 2_700));
        });
      }, 1_500);
    };
    play();
    const loop = window.setInterval(play, 11_500);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(loop);
      timeouts.forEach(window.clearTimeout);
    };
  }, [content]);

  const avatarState = stage === "thinking" ? "thinking" : stage === "working" ? "working" : "happy";
  const motion = stage === "thinking" ? "thinking" : stage === "working" ? "working" : "success";
  const value = useMemo(() => ({
    state,
    dispatch: () => {},
    flushBotPatches: async () => null,
    refreshInstances: async () => {},
    refreshModels: async () => {},
  }), [state]);

  return (
    <StoreContext.Provider value={value}>
      <main className="flex h-dvh min-h-[430px] w-full overflow-hidden bg-app text-ink">
        <div className="flex min-w-0 flex-1 flex-col" data-demo-client="true" data-demo-layout={layout}>
          <div className="flex h-[62px] shrink-0 items-center justify-between border-b border-hairline/50 px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <MausAvatar color="red" bodyId="circle" size={34} state={avatarState} motion={motion} motionKey={motionKey} label="DoneBot 圆脸头像" />
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">DoneBot</div>
                <div className="truncate text-[11px] text-ink-secondary">{content.label} · {stage === "thinking" ? "正在理解任务" : stage === "working" ? "正在执行" : "已完成"}</div>
              </div>
            </div>
            <div className="hidden items-center gap-2 text-[11px] text-ink-secondary sm:flex">
              <span className="size-1.5 rounded-full bg-accent" />
              {stage === "success" ? "任务完成" : "自动执行中"}
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <ChatView bot={state.bots[0]!} />
          </div>
        </div>
      </main>
    </StoreContext.Provider>
  );
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (new URL(url, location.href).pathname.startsWith("/api/")) {
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input, init);
};

createRoot(document.getElementById("root")!).render(<StrictMode><Demo /></StrictMode>);
