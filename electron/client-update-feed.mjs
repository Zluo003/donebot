const UPDATE_ORIGIN = "https://donebot.cn";

export function clientUpdateFeed(platform, arch, configuredOrigin = "") {
  const target = platform === "win32" && arch === "x64"
    ? "windows-x64"
    : platform === "darwin" && arch === "arm64"
      ? "macos-arm64"
      : null;
  if (!target) return null;

  let origin;
  try {
    const parsed = new URL(configuredOrigin.trim() || UPDATE_ORIGIN);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    origin = parsed.origin + parsed.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
  return { provider: "generic", url: `${origin}/api/v1/client/updates/${target}/` };
}
