import { apimartImages } from "./apimart-images.ts";
import { apimartMusic } from "./apimart-music.ts";
import type { MediaKind } from "./media-store.ts";
import { mediaObject, mediaTaskId } from "./media-wire.ts";

export interface MediaAdapter {
  kind: MediaKind;
  submit: string;
  edit?: string;
  poll?: (id: string) => string;
  taskId: (body: Record<string, unknown>) => string | undefined;
  results: (body: Record<string, unknown>) => unknown[];
}

const nativeTaskId = (body: Record<string, unknown>) => mediaTaskId(body.id ?? body.task_id);

export const MEDIA_ADAPTERS: Readonly<Record<string, MediaAdapter>> = {
  "donebot.images.async.v1": {
    kind: "image", submit: "/v1/images/generations/async", edit: "/v1/images/edits/async", poll: id => `/v1/images/tasks/${id}`,
    taskId: nativeTaskId,
    results: body => { const data = mediaObject(body.result)?.data; return Array.isArray(data) ? data : []; },
  },
  "openai.images.v1": {
    kind: "image", submit: "/v1/images/generations", taskId: nativeTaskId,
    results: body => Array.isArray(body.data) ? body.data : [],
  },
  "apimart.images.v1": apimartImages,
  "apimart.music.v1": apimartMusic,
  "seedance.videos.v1": {
    kind: "video", submit: "/v1/videos", poll: id => `/v1/videos/${id}`,
    taskId: nativeTaskId, results: () => [],
  },
};
