import { z } from "zod";

const coordinate = z.number().finite().min(0);
const box = (maximum: number) => z.tuple([
  coordinate.max(maximum), coordinate.max(maximum), coordinate.max(maximum), coordinate.max(maximum),
]).refine(([left, top, right, bottom]) => right > left && bottom > top);
const dimensions = z.string().regex(/^[1-9]\d{0,5}x[1-9]\d{0,5}$/).refine(value => {
  const [width, height] = value.split("x").map(Number);
  return width! * height! <= 36_000_000;
});

export const mediaLayerSchema = z.object({
  z_index: z.number().int().min(0).max(16),
  size: dimensions.optional(),
  output_format: z.enum(["jpeg", "png"]).optional(),
  name: z.string().max(256).optional(),
  description: z.string().max(2048).optional(),
  bounding_box: z.object({
    absolute: box(36_000_000).optional(),
    normalized: box(1000).optional(),
  }).optional(),
});

export function mediaLayer(value: unknown): z.infer<typeof mediaLayerSchema> | undefined {
  const parsed = mediaLayerSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
