import { POST as handleFileImport } from "../file/route";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleFileImport(request);
}
