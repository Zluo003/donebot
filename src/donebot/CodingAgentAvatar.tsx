import { useId } from "react";
import {
  codingAgentById,
  type ExternalCodingAgentId,
} from "../../shared/coding-agents";
import {
  ClaudeMark,
  CodexMark,
  DeepSeekMark,
  ZCodeMark,
} from "@/components/ProviderIcons";
import { cn } from "@/lib/cn";

function AntigravityBrandMark({ size }: { size: number }) {
  const gradId = `ag-brand-${useId().replace(/\W/gu, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#3B82F6" />
          <stop offset="50%" stopColor="#6366F1" />
          <stop offset="100%" stopColor="#10B981" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradId})`}
        fillRule="evenodd"
        d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z"
      />
    </svg>
  );
}

const TILE_STYLE: Record<
  ExternalCodingAgentId,
  { background: string; border: string }
> = {
  claude: {
    background: "linear-gradient(145deg, #E28564 0%, #D97757 60%, #C66242 100%)",
    border: "1px solid rgba(255,255,255,0.16)",
  },
  codex: {
    background: "linear-gradient(145deg, #1E2430 0%, #111318 100%)",
    border: "1px solid rgba(255,255,255,0.14)",
  },
  antigravity: {
    background: "linear-gradient(145deg, #FFFFFF 0%, #EEF3FF 100%)",
    border: "1px solid rgba(59,130,246,0.22)",
  },
  deepseek: {
    background: "linear-gradient(145deg, #FFFFFF 0%, #EDF3FF 100%)",
    border: "1px solid rgba(77,107,254,0.22)",
  },
  zcode: {
    background: "linear-gradient(145deg, #1A1A1E 0%, #09090B 100%)",
    border: "1px solid rgba(255,255,255,0.14)",
  },
};

export function CodingAgentAvatar({
  agentId,
  size = 44,
  label,
  className,
}: {
  agentId: ExternalCodingAgentId;
  size?: number;
  label?: string;
  className?: string;
}) {
  const spec = codingAgentById(agentId);
  const glyphSize = Math.max(11, Math.round(size * 0.62));
  const radius = Math.max(4, Math.round(size * 0.26));
  const tile = TILE_STYLE[agentId];

  const glyph = (() => {
    switch (agentId) {
      case "claude":
        return <ClaudeMark size={glyphSize} className="!fill-white" />;
      case "codex":
        return <CodexMark size={glyphSize} className="!fill-white" />;
      case "antigravity":
        return <AntigravityBrandMark size={glyphSize} />;
      case "deepseek":
        return <DeepSeekMark size={Math.max(12, Math.round(size * 0.66))} />;
      case "zcode":
        return <ZCodeMark size={Math.max(12, Math.round(size * 0.66))} className="!fill-white" />;
    }
  })();

  return (
    <span
      role="img"
      data-coding-agent-avatar={agentId}
      aria-label={label ?? spec?.displayName ?? agentId}
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden shadow-xs",
        className,
      )}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: tile.background,
        border: tile.border,
      }}
    >
      {glyph}
    </span>
  );
}
