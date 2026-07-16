import { NextResponse } from "next/server";

const customerSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    customer_type: { type: "string", enum: ["person", "company"] },
    lifecycle: { type: "string", enum: ["prospect", "lead", "customer", "former_customer", "lost", "blocked"] },
    display_name: { type: "string" },
    email: { type: ["string", "null"], format: "email" },
    phone_e164: { type: ["string", "null"] },
    organization_number: { type: ["string", "null"] },
  },
};

export async function GET() {
  return NextResponse.json({
    openapi: "3.1.0",
    info: {
      title: "Kundexa API",
      version: "1.1.0",
      description: "Tenant-isolerat API för CRM, licensstyrd katalog, datainsamling, segment, avtal, import och telefoni. API-nycklar lagras endast hashade.",
    },
    servers: [{ url: "/api/v1" }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "Kundexa API key or Supabase session" } },
      schemas: {
        Customer: customerSchema,
        Error: { type: "object", properties: { error: { type: "string" }, details: { type: "array", items: {} } }, required: ["error"] },
      },
    },
    paths: {
      "/customers": {
        get: {
          operationId: "listCustomers",
          summary: "Lista och sök kunder",
          parameters: [
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          ],
          responses: { "200": { description: "Kundlista", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Customer" } } } } } } } },
        },
        post: {
          operationId: "createCustomer",
          summary: "Skapa kund idempotent",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["customer_type", "display_name"], properties: { customer_type: { type: "string", enum: ["person", "company"] }, display_name: { type: "string", minLength: 2 }, lifecycle: { type: "string", enum: ["prospect", "lead", "customer"] }, email: { type: "string", format: "email" }, phone: { type: "string" }, organization_number: { type: "string" }, city: { type: "string" }, idempotency_key: { type: "string", minLength: 8 } } } } } },
          responses: { "201": { description: "Skapad" }, "422": { description: "Valideringsfel" } },
        },
      },
      "/customers/{id}": {
        get: { operationId: "getCustomer", summary: "Hämta komplett kundkort", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Kundkort" }, "404": { description: "Saknas" } } },
        patch: { operationId: "updateCustomer", summary: "Uppdatera tillåtna kundfält", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false } } } }, responses: { "200": { description: "Uppdaterad" } } },
      },
      "/contracts": {
        get: { operationId: "listContracts", summary: "Lista avtal", responses: { "200": { description: "Avtalslista" } } },
      },
      "/imports/file": {
        post: { operationId: "previewFileImport", summary: "Säkerhetsskanna, ladda upp och validera CSV, JSON, NDJSON, XML eller XLSX", security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["name", "file"], properties: { name: { type: "string" }, file: { type: "string", format: "binary", description: "Högst 50 MB" }, simulate: { type: "boolean" } } } } } }, responses: { "303": { description: "Resultat visas i webbappen" } } },
      },
      "/calls": {
        post: { operationId: "startBrowserCall", summary: "Köa ett WebRTC-bryggat samtal för inloggad användare", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["customerId"], properties: { customerId: { type: "string", format: "uuid" } } } } } }, responses: { "202": { description: "Samtalet är köat" }, "409": { description: "Telefoni saknas eller kunden är spärrad" } } },
      },
      "/voice-client": {
        get: { operationId: "getVoiceClient", summary: "Hämta kortlivad WebRTC-konfiguration för aktuell användare", responses: { "200": { description: "WebRTC-konfiguration" } } },
      },

      "/directory/discover": {
        post: { operationId: "discoverDirectoryEntities", summary: "Starta tillståndsstyrd discovery/ingestion från en konfigurerad källa", "x-required-scope": "directory:refresh", responses: { "202": { description: "Ingestionjobb schemalagt" } } },
      },
      "/segments/{id}/refresh": {
        post: { operationId: "refreshSegment", summary: "Materialisera ett dynamiskt segment", "x-required-scope": "segments:write", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Nytt snapshot" } } },
      },
      "/segments/{id}/campaign": {
        post: { operationId: "sendSegmentToCampaign", summary: "Skapa tenantkunder och lägg policygodkända medlemmar i kampanj", "x-required-scope": "segments:write", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Materialiseringsresultat" } } },
      },
      "/directory/search": {
        post: { operationId: "searchDirectory", summary: "Sök lokalt i den licensstyrda katalogen", "x-required-scope": "directory:read", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { entityType: { type: "string", enum: ["organization", "establishment", "person"] }, query: { type: ["string", "null"] }, county: { type: ["string", "null"] }, municipality: { type: ["string", "null"] }, city: { type: ["string", "null"] }, sniCode: { type: ["string", "null"] }, postalCode: { type: ["string", "null"] }, legalForm: { type: ["string", "null"] }, organizationStatus: { type: ["string", "null"] }, dataProviderId: { type: ["string", "null"], format: "uuid" }, ageMin: { type: ["integer", "null"] }, ageMax: { type: ["integer", "null"] }, employeeMin: { type: ["integer", "null"] }, employeeMax: { type: ["integer", "null"] }, hasPhone: { type: ["boolean", "null"] }, hasEmail: { type: ["boolean", "null"] }, hasWebsite: { type: ["boolean", "null"] }, revenueMin: { type: ["number", "null"] }, revenueMax: { type: ["number", "null"] }, nixStatus: { type: ["string", "null"] }, blocked: { type: ["boolean", "null"] }, allowedChannel: { type: ["string", "null"], enum: ["call", "sms", "email", null] }, contractStatus: { type: ["string", "null"] }, activeContract: { type: ["boolean", "null"] }, freshOnly: { type: "boolean", default: false }, limit: { type: "integer", maximum: 200, default: 50 }, offset: { type: "integer", default: 0 } } } } } }, responses: { "200": { description: "Lokala katalogträffar med freshness-sammanställning" } } },
      },
      "/directory/entities/{id}": {
        get: { operationId: "getDirectoryEntity", summary: "Hämta en licensierad katalogentitet", "x-required-scope": "directory:read", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Katalogentitet" }, "404": { description: "Saknas eller inte licensierad för tenanten" } } },
      },
      "/directory/entities/{id}/refresh": {
        post: { operationId: "refreshDirectoryEntity", summary: "Köa idempotent berikning", "x-required-scope": "directory:refresh", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { purpose: { type: "string", default: "crm_refresh" }, enrichmentType: { type: "string", default: "full" }, requestedFields: { type: "array", items: { type: "string" } }, force: { type: "boolean", default: false }, idempotencyKey: { type: "string" } } } } } }, responses: { "202": { description: "Berikningsjobb köat" }, "409": { description: "Tillstånd, feature eller licensägarskap blockerar uppdateringen" } } },
      },
      "/enrichment/jobs": {
        post: { operationId: "createEnrichmentJobs", summary: "Köa berikning för flera entiteter", "x-required-scope": "directory:refresh", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["entityIds"], properties: { entityIds: { type: "array", minItems: 1, maxItems: 500, items: { type: "string", format: "uuid" } }, purpose: { type: "string" }, requestedFields: { type: "array", items: { type: "string" } }, force: { type: "boolean" }, idempotencyKey: { type: "string" } } } } } }, responses: { "202": { description: "Jobbresultat och beräknad kostnad" } } },
      },
      "/segments": {
        get: { operationId: "listSegments", summary: "Lista segment", "x-required-scope": "directory:read", responses: { "200": { description: "Segmentlista" } } },
        post: { operationId: "createSegment", summary: "Skapa dynamiskt segment", "x-required-scope": "segments:write", responses: { "201": { description: "Segment skapat" } } },
      },
      "/segments/preview": {
        post: { operationId: "previewSegment", summary: "Förhandsvisa segment lokalt utan externa anrop", "x-required-scope": "directory:read", responses: { "200": { description: "Urval och freshness-sammanställning" } } },
      },
    },
  }, { headers: { "cache-control": "public, max-age=300" } });
}
