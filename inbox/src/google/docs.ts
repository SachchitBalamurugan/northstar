// Google Docs, read-only, for the task agent ("use my essay doc for this application").
//   GET /docs/search?q=   → { files: [{ id, name, modifiedTime, url }] }  (Docs only, newest first)
//   GET /docs/:id/text    → { id, title, text }
// Needs the drive.metadata.readonly + documents.readonly scopes (Connect Google again after updating).
import type { FastifyInstance } from "fastify";
import { google, type docs_v1 } from "googleapis";
import { getAuthedClient } from "./auth.js";

const DOC_MIME = "application/vnd.google-apps.document";
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

function textOf(content: docs_v1.Schema$StructuralElement[] | undefined, out: string[]) {
  for (const el of content ?? []) {
    if (el.paragraph) {
      const line = (el.paragraph.elements ?? []).map((e) => e.textRun?.content ?? "").join("");
      out.push(line.replace(/\n$/, ""));
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map((c) => {
          const parts: string[] = [];
          textOf(c.content, parts);
          return parts.join(" ").trim();
        });
        out.push(cells.join(" | "));
      }
    } else if (el.tableOfContents) textOf(el.tableOfContents.content, out);
  }
}

function tabsText(tabs: docs_v1.Schema$Tab[] | undefined, out: string[]) {
  for (const t of tabs ?? []) {
    const title = t.tabProperties?.title;
    if (title && (tabs?.length ?? 0) > 1) out.push(`## ${title}`);
    textOf(t.documentTab?.body?.content, out);
    tabsText(t.childTabs, out);
  }
}

function googleError(err: unknown): { code: number; error: string } {
  const e = err as { code?: number; message?: string };
  const msg = e?.message ?? String(err);
  if (/not signed in|token/i.test(msg)) return { code: 401, error: "Google is not connected. Connect Google in Northstar first." };
  if (/insufficient|scope|permission/i.test(msg))
    return { code: 403, error: "Northstar can't read Google Docs yet. Connect Google again and tick the Drive and Docs boxes." };
  if (/has not been used|is disabled/i.test(msg))
    return { code: 503, error: "The Google Docs or Drive API is turned off for this Google Cloud project. Turn on 'Google Docs API' and 'Google Drive API' in Google Cloud Console." };
  return { code: typeof e?.code === "number" && e.code >= 400 && e.code < 600 ? e.code : 502, error: msg };
}

export async function docsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>("/docs/search", async (req, reply) => {
    const q = (req.query.q ?? "").trim().slice(0, 200);
    try {
      const auth = await getAuthedClient();
      const drive = google.drive({ version: "v3", auth });
      const base = `mimeType='${DOC_MIME}' and trashed=false`;
      const list = async (extra: string) =>
        (
          await drive.files.list({
            q: extra ? `${base} and ${extra}` : base,
            orderBy: extra.startsWith("fullText") ? undefined : "modifiedTime desc",
            pageSize: 10,
            fields: "files(id,name,modifiedTime,webViewLink)",
          })
        ).data.files ?? [];
      let files = await list(q ? `name contains '${esc(q)}'` : "");
      if (!files.length && q) {
        // Fall back to the separate words, then to full-text search (may need wider access; ignore if refused).
        const words = q.split(/\s+/).filter((w) => w.length > 2).slice(0, 4);
        if (words.length > 1) files = await list(words.map((w) => `name contains '${esc(w)}'`).join(" and "));
        if (!files.length) files = await list(`fullText contains '${esc(q)}'`).catch(() => []);
      }
      return { files: files.map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, url: f.webViewLink })) };
    } catch (err) {
      const { code, error } = googleError(err);
      return reply.code(code).send({ error });
    }
  });

  app.get<{ Params: { id: string } }>("/docs/:id/text", async (req, reply) => {
    if (!/^[\w-]{20,}$/.test(req.params.id)) return reply.code(400).send({ error: "bad document id" });
    try {
      const auth = await getAuthedClient();
      const docs = google.docs({ version: "v1", auth });
      const { data } = await docs.documents.get({ documentId: req.params.id, includeTabsContent: true });
      const out: string[] = [];
      if (data.tabs?.length) tabsText(data.tabs, out);
      else textOf(data.body?.content, out);
      const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      return { id: req.params.id, title: data.title ?? "", text: text.slice(0, 60_000), truncated: text.length > 60_000 };
    } catch (err) {
      const { code, error } = googleError(err);
      return reply.code(code).send({ error });
    }
  });
}
