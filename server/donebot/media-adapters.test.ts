import { describe, expect, it } from "vitest";
import { MEDIA_ADAPTERS } from "./media-adapters.ts";

describe("DoneBot independent native media adapters", () => {
  const images = MEDIA_ADAPTERS["apimart.images.v1"]!, music = MEDIA_ADAPTERS["apimart.music.v1"]!;
  it("keeps image and music submission and lookup contracts separate", () => {
    expect(images.submit).toBe("/v1/images/generations");
    expect(images.poll!("image-task")).toBe("/v1/tasks/image-task");
    expect(music.submit).toBe("/v1/music/generations");
    expect(music.poll!("music-task")).toBe("/v1/music/tasks/music-task");
    expect(MEDIA_ADAPTERS["apimart.speech.v1"]).toBeUndefined();
  });
  it("reads only its own native output shape and preserves every image URL", () => {
    const body = { data: { result: {
      images: [{ url: ["https://image.invalid/first.png", "https://image.invalid/second.png"] }, { url: "https://image.invalid/third.png" }],
      music: [{ audio_url: "https://audio.invalid/song.mp3" }],
    } } };
    expect(images.results(body)).toEqual([
      { url: "https://image.invalid/first.png" },
      { url: "https://image.invalid/second.png" },
      { url: "https://image.invalid/third.png" },
    ]);
    const layerBody = { data: { result: { images: [{
      url: ["https://image.invalid/base.jpg", "https://image.invalid/layer.png"],
      layer_decomposition: true,
      layers: [
        { z_index: 0, size: "1024x768", output_format: "jpeg", name: "base", description: "environment" },
        { z_index: 1, output_format: "png", name: "subject", description: "foreground", bounding_box: { normalized: [12, 24, 880, 960] } },
      ],
    }] } } };
    expect(images.results(layerBody)).toEqual([
      { url: "https://image.invalid/base.jpg", layer: { z_index: 0, size: "1024x768", output_format: "jpeg", name: "base", description: "environment" } },
      { url: "https://image.invalid/layer.png", layer: { z_index: 1, output_format: "png", name: "subject", description: "foreground", bounding_box: { normalized: [12, 24, 880, 960] } } },
    ]);
    expect(music.results(body)).toEqual([{ audio_url: "https://audio.invalid/song.mp3" }]);
    expect(images.results({ data: { result: { music: body.data.result.music } } })).toEqual([]);
    expect(music.results({ data: { result: { images: body.data.result.images } } })).toEqual([]);
  });
  it.each([images, music])("rejects malformed or unrelated task identities", adapter => {
    expect(adapter.taskId({ data: [{ task_id: "native-task" }] })).toBe("native-task");
    expect(adapter.taskId({ data: [{ task_id: "../../other" }] })).toBeUndefined();
    expect(adapter.taskId({ id: "unrelated" })).toBeUndefined();
  });
});
