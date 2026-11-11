import type { MediaAdapter } from "./media-adapters.ts";
import { mediaObject, mediaTaskId } from "./media-wire.ts";
import { mediaLayer } from "./media-layers.ts";

export const apimartImages: MediaAdapter = {
  kind: "image",
  submit: "/v1/images/generations",
  poll: id => `/v1/tasks/${id}`,
  taskId: body => mediaTaskId(mediaObject(Array.isArray(body.data) ? body.data[0] : undefined)?.task_id),
  results(body) {
    const result = mediaObject(mediaObject(body.data)?.result) ?? mediaObject(body.result);
    if (!Array.isArray(result?.images)) return [];
    return result.images.flatMap(image => {
      const row = mediaObject(image);
      if (!row || row.url === undefined) return [image];
      const urls = Array.isArray(row.url) ? row.url : [row.url];
      return urls.map((url, index) => {
        const raw = Array.isArray(row.layers) ? mediaObject(row.layers[index]) : undefined;
        const layer = row.layer_decomposition === true && raw ? mediaLayer({ ...raw,
          size: raw.size ?? (Array.isArray(row.sizes) ? row.sizes[index] : undefined),
          output_format: raw.output_format ?? (Array.isArray(row.output_formats) ? row.output_formats[index] : undefined),
          background: raw.background ?? (Array.isArray(row.backgrounds) ? row.backgrounds[index] : undefined),
        }) : undefined;
        return { url, ...(layer ? { layer } : {}) };
      });
    });
  },
};
