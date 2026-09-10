import { getAppContext } from "@/lib/auth";
import { extractDocumentText, DocumentTextError } from "@/lib/contracts/document-text";

// Reading an uploaded agreement into the template editor is a session-only helper
// for the authoring screen: it stores nothing and returns the text to the form the
// author is already filling in. The role set is the same one that may create a
// template version, so this cannot become a way to read documents without it.
const AUTHORING_ROLES = ["owner", "admin", "contract_manager", "team_lead"];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request) {
  let context;
  try {
    context = await getAppContext();
  } catch {
    return Response.json({ error: "authentication_required" }, { status: 401 });
  }
  if (!AUTHORING_ROLES.includes(context.role)) {
    return Response.json({ error: "Du saknar behörighet att skapa avtalsmallar." }, { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "Ingen fil togs emot." }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "Filen är större än 10 MB." }, { status: 413 });
  }

  try {
    const extracted = extractDocumentText(Buffer.from(await file.arrayBuffer()), file.name);
    return Response.json({ text: extracted.text, sourceType: extracted.sourceType, fileName: file.name });
  } catch (error) {
    // The extractor's refusals are written for the person uploading the file and
    // say what to do instead, so they are returned as-is. Anything else is a bug
    // here rather than a problem with their document.
    if (error instanceof DocumentTextError) {
      return Response.json({ error: error.message }, { status: 422 });
    }
    return Response.json({ error: "Dokumentet kunde inte läsas." }, { status: 500 });
  }
}
