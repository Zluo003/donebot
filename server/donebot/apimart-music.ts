import type { MediaAdapter } from "./media-adapters.ts";
import { mediaObject, mediaTaskId } from "./media-wire.ts";

export const apimartMusic: MediaAdapter = {
  kind: "music",
  submit: "/v1/music/generations",
  poll: id => `/v1/music/tasks/${id}`,
  taskId: body => mediaTaskId(mediaObject(Array.isArray(body.data) ? body.data[0] : undefined)?.task_id),
  results(body) {
    const result = mediaObject(mediaObject(body.data)?.result) ?? mediaObject(body.result);
    return Array.isArray(result?.music) ? result.music : [];
  },
};
