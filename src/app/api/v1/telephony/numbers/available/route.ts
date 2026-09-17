import { NextResponse } from "next/server";
import { getAppContext, isAdmin } from "@/lib/auth";
import { NumberProviderError, numberProvider } from "@/lib/telephony/numbers";

export const runtime = "nodejs";

/**
 * Lediga nummer hos leverantören.
 *
 * Bara administratörer. Sökningen kostar ingenting, men den avslöjar vilket
 * leverantörskonto Kundexa kör på och hur mycket numren kostar -- och nästa steg
 * efter en sökning är en knapp som skickar en faktura.
 */
export async function GET(request: Request) {
  const context = await getAppContext();
  if (!isAdmin(context.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const provider = numberProvider();
  if (!provider.isConfigured()) {
    return NextResponse.json({
      error: "number_provider_not_configured",
      message: "Nummerhyra är inte uppsatt. Plattformsadministratören behöver lägga in leverantörens projekt-id och nyckel.",
    }, { status: 503 });
  }

  const url = new URL(request.url);
  const regionCode = (url.searchParams.get("regionCode") ?? "SE").toUpperCase();
  const numberType = (url.searchParams.get("numberType") ?? "LOCAL").toUpperCase();
  const pattern = (url.searchParams.get("pattern") ?? "").replace(/[^0-9]/g, "").slice(0, 10);

  // Tillåtna värden räknas upp. Att skicka vidare vad som helst till
  // leverantören gör deras validering till vår felhantering.
  if (!/^[A-Z]{2}$/.test(regionCode)) {
    return NextResponse.json({ error: "region_invalid", message: "Landskoden ska vara två bokstäver, t.ex. SE." }, { status: 400 });
  }
  if (!["LOCAL", "MOBILE", "TOLL_FREE"].includes(numberType)) {
    return NextResponse.json({ error: "number_type_invalid", message: "Okänd nummertyp." }, { status: 400 });
  }

  try {
    const numbers = await provider.search({ regionCode, numberType, pattern: pattern || undefined, limit: 20 });
    return NextResponse.json({ numbers });
  } catch (error) {
    if (error instanceof NumberProviderError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 502 });
    }
    console.error("number_search_failed", { name: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: "number_search_failed", message: "Sökningen kunde inte genomföras." }, { status: 500 });
  }
}
