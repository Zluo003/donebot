import type { DataSheet, DataTable } from "../../shared/data-surface";

export function dataTablesFromResponse(body: unknown): DataTable[] {
  const tables = body && typeof body === "object" && "tables" in body ? (body as { tables: unknown }).tables : undefined;
  return Array.isArray(tables) ? (tables as DataTable[]).filter((table) => table && typeof table.name === "string") : [];
}

export function dataSheetFromResponse(body: unknown, botId: string): DataSheet {
  const candidate = body && typeof body === "object" && "sheet" in body ? (body as { sheet: unknown }).sheet : body;
  if (candidate && typeof candidate === "object" && Array.isArray((candidate as DataSheet).cards)) {
    const sheet = candidate as DataSheet;
    return { ...sheet, botId: sheet.botId || botId, sources: Array.isArray(sheet.sources) ? sheet.sources : [] };
  }
  return { version: 1, botId, cards: [], sources: [], updatedAt: new Date(0).toISOString() };
}

