import { z } from "zod";

export const automationEnabledSchema = z.object({ enabled: z.boolean() }).strict();
