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
  z_index: z.number().int().min(0).max(99),
  size: dimensions.optional(),
  output_format: z.enum(["jpeg", "png"]).optional(),
  background: z.enum(["opaque", "transparent"]).optional(),
  text_recognition: z.object({
    text: z.string().max(100_000).optional(),
    lines: z.array(z.object({ bounding_box: z.object({ absolute: box(36_000_000).optional(), normalized: box(1000).optional() }).optional(),
      runs: z.array(z.object({ text: z.string().max(100_000).optional(), style: z.object({
        similar_font_family: z.string().max(256).optional(), foreground_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
        bold: z.boolean().optional(), italic: z.boolean().optional(), underline: z.boolean().optional(),
        strikethrough: z.boolean().optional(), shadow: z.boolean().optional(), translucent: z.boolean().optional(),
      }).optional() })).max(1000).optional(),
    })).max(1000).optional(),
  }).optional(),
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
