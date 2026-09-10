import { inflateRawSync } from "node:zlib";

// Turning an uploaded agreement into a reusable template means getting its text
// out of the file the lawyer wrote it in. Only the text is wanted: the body is
// re-rendered into Kundexa's own PDF with the customer's data merged in, so the
// source file's fonts, margins and headers are not carried over and would only
// have to be stripped again.

export type ExtractedDocument = { text: string; sourceType: "docx" | "text" | "html" };

export class DocumentTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentTextError";
  }
}

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 100_000;

// A .docx is a ZIP archive. Reading it needs no dependency: locate the end-of-
// central-directory record, walk the entries, and inflate the one that holds the
// document body. Doing it by hand keeps a parser for untrusted input small enough
// to read in full, which matters more here than generality.
function readZipEntry(archive: Buffer, wanted: string): Buffer | null {
  const EOCD_SIGNATURE = 0x06054b50;
  const CENTRAL_SIGNATURE = 0x02014b50;
  // The trailing comment may be up to 65535 bytes, so scan backwards over that
  // window rather than assuming the record sits at the very end.
  let eocd = -1;
  const scanFrom = Math.max(0, archive.length - 22 - 65535);
  for (let offset = archive.length - 22; offset >= scanFrom; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) { eocd = offset; break; }
  }
  if (eocd < 0) throw new DocumentTextError("Filen är inte ett giltigt .docx-dokument.");

  const entryCount = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new DocumentTextError("Filen är inte ett giltigt .docx-dokument.");
    }
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    if (name === wanted) {
      // The central directory's name and extra lengths need not match the local
      // header's, so read the sizes that actually precede the data.
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = archive.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new DocumentTextError("Dokumentet använder en komprimering som inte stöds.");
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    // Ampersand last, so an escaped entity is not decoded twice.
    .replace(/&amp;/g, "&");
}

// Word stores a paragraph as <w:p> containing runs of <w:t>. Reading the text
// nodes in document order and breaking at the structural elements reproduces the
// paragraphs a person sees, which is what the template body needs.
function docxXmlToText(xml: string) {
  const out: string[] = [];
  // `<w:p/>` is how Word writes an empty line, and an empty line between clauses
  // is part of how a contract reads, so it counts as a break like `</w:p>` does.
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>|<w:p\b[^>]*\/>|<\/w:p>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    // Test the capture group, not the tag's prefix: `<w:tab/>` also starts with
    // `<w:t`, so a prefix check silently swallows every tab.
    if (match[1] !== undefined) out.push(decodeXmlEntities(match[1]));
    else if (match[0].startsWith("<w:tab")) out.push("\t");
    else out.push("\n");
  }
  return out.join("");
}

// XML defines five named entities; HTML defines well over a thousand. Rather than
// carry the full table, cover the ones a Swedish contract actually produces —
// letters, dashes and legal marks — and let everything else fall through to the
// numeric forms, which are already handled.
const HTML_ENTITIES: Record<string, string> = {
  nbsp: " ", aring: "å", Aring: "Å", auml: "ä", Auml: "Ä", ouml: "ö", Ouml: "Ö",
  eacute: "é", Eacute: "É", aelig: "æ", AElig: "Æ", oslash: "ø", Oslash: "Ø", szlig: "ß",
  ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»", bull: "•", middot: "·",
  deg: "°", sect: "§", para: "¶", copy: "©", reg: "®", trade: "™", euro: "€",
  times: "×", divide: "÷", frac12: "½", frac14: "¼", sup2: "²", sup3: "³",
};

function htmlToText(html: string) {
  return decodeXmlEntities(
    html
      .replace(/&([A-Za-z][A-Za-z0-9]{1,10});/g, (whole, name: string) => HTML_ENTITIES[name] ?? whole)
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<br\b[^>]*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  );
}

// Word leaves a lot of empty paragraphs behind. Collapse runs of blank lines so
// the extracted body reads like the document rather than like its markup.
function tidy(text: string) {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/ /g, " ");
  const lines = normalized.split("\n").map((line) => line.replace(/[ \t]+$/g, ""));
  const collapsed: string[] = [];
  for (const line of lines) {
    if (line.trim() === "" && collapsed.at(-1)?.trim() === "") continue;
    collapsed.push(line);
  }
  return collapsed.join("\n").trim();
}

export function extractDocumentText(buffer: Buffer, fileName: string): ExtractedDocument {
  if (buffer.length === 0) throw new DocumentTextError("Filen är tom.");
  if (buffer.length > MAX_INPUT_BYTES) throw new DocumentTextError("Filen är större än 10 MB.");
  const extension = fileName.toLowerCase().split(".").pop() ?? "";

  let text: string;
  let sourceType: ExtractedDocument["sourceType"];
  if (extension === "docx") {
    const document = readZipEntry(buffer, "word/document.xml");
    if (!document) throw new DocumentTextError("Dokumentet saknar innehåll som kan läsas.");
    text = docxXmlToText(document.toString("utf8"));
    sourceType = "docx";
  } else if (extension === "html" || extension === "htm") {
    text = htmlToText(buffer.toString("utf8"));
    sourceType = "html";
  } else if (extension === "txt" || extension === "md") {
    text = buffer.toString("utf8");
    sourceType = "text";
  } else if (extension === "doc") {
    throw new DocumentTextError("Det gamla .doc-formatet stöds inte. Spara om avtalet som .docx.");
  } else if (extension === "pdf") {
    // A PDF stores glyphs and positions, not paragraphs. Text pulled back out of
    // one arrives with broken line breaks, split words and lost ordering in
    // multi-column layouts — and a contract template that is subtly garbled is
    // worse than no import at all, because the damage is easy to miss.
    throw new DocumentTextError(
      "PDF kan inte läsas in som mall: texten går inte att få ut med bevarad styckeindelning. Ladda upp avtalet som .docx, eller klistra in texten.",
    );
  } else {
    throw new DocumentTextError("Filformatet stöds inte. Använd .docx, .txt, .md eller .html.");
  }

  const tidied = tidy(text);
  if (!tidied) throw new DocumentTextError("Dokumentet innehåller ingen läsbar text.");
  if (tidied.length > MAX_TEXT_CHARACTERS) {
    throw new DocumentTextError(`Avtalstexten är ${tidied.length} tecken, vilket överskrider gränsen på ${MAX_TEXT_CHARACTERS}.`);
  }
  return { text: tidied, sourceType };
}
