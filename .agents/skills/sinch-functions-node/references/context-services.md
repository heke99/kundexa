> **Summary — not the spec.** This file orients you and links to the authoritative
> `developers.sinch.com` doc; it may lag, omit fields, or simplify nesting. Do **not**
> copy field names, nesting, encodings, or enums from here into shipped code without
> confirming them in the linked doc. See "Source of Truth" in this skill's SKILL.md.

# FunctionContext services — SDK, cache, storage, database (Node.js)

Reference for calling the bundled Sinch SDK and the cache/storage/database services on `FunctionContext`. Loaded on-demand from [SKILL.md](../SKILL.md).

## Using the bundled SDK

**The complete Sinch SDK is bundled and pre-configured** — you do NOT install `@sinch/sdk-core` separately, and you do NOT handle authentication. SDK clients are auto-initialized from environment variables when your function starts. If credentials for a particular product aren't set, that property is `null` — always use optional chaining. See the [Sinch Node SDK reference](https://developers.sinch.com/docs/sdks.md) for method signatures.

```typescript
// Send an SMS confirmation from the ICE handler
// data.cli is the caller's phone number in E.164 format
async ice(context, data) {
  await context.sms?.batches.send({
    sendSMSRequestBody: {
      to: [data.cli ?? ''],
      from: context.env.SMS_SENDER,
      body: 'Thanks for calling! A summary will arrive shortly.',
    },
  });

  return new IceSvamlBuilder().say('Connecting you now.').connectPstn('+15551234567').build();
}

// Send a WhatsApp message — message body shape is standard Conversation API.
// See the sinch-conversation-api skill for channels, templates, rich cards, etc.
await context.conversation?.messages.send({
  sendMessageRequestBody: {
    app_id: context.env.CONVERSATION_APP_ID,
    recipient: { identified_by: { channel_identities: [{ channel: 'WHATSAPP', identity: '+15551234567' }] } },
    message: { text_message: { text: 'Hello!' } },
  },
});

// Make an outbound voice call
await context.voice?.calls.callouts.call({
  calloutRequestBody: {
    method: 'ttsCallout',
    ttsCallout: {
      destination: { type: 'number', endpoint: '+15551234567' },
      locale: 'en-US',
      text: 'Your appointment is confirmed.',
    },
  },
});

// Rent a phone number
await context.numbers?.availableNumbers.rent({ ... });
```

## Cache

Key-value store. In dev: in-memory. In prod: persistent, shared across instances.

```typescript
await context.cache.set('session:abc', { userId: 'u1' }, 1800);  // TTL in seconds
const val = await context.cache.get<MyType>('session:abc');
await context.cache.has('key');
await context.cache.delete('key');
const keys = await context.cache.keys('session:*');
const values = await context.cache.getMany<MyType>(keys);  // batch read
await context.cache.extend('key', 600);  // extend TTL
```

Default TTL: 3600 seconds (1 hour).

## Storage

File/blob storage. In dev: `./storage/`. In prod: S3-backed.

```typescript
await context.storage.write('reports/daily.json', JSON.stringify(data));
const buf = await context.storage.read('reports/daily.json');
const files = await context.storage.list('reports/');
await context.storage.exists('file.txt');
await context.storage.delete('file.txt');
```

## Database

`context.database` is a path to a per-function SQLite database that is durable in production (continuously replicated behind the scenes — no code changes required). Use `sql.js` (recommended, no native deps) or `better-sqlite3`.

```typescript
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const SQL = await initSqlJs();
const buf = existsSync(context.database) ? readFileSync(context.database) : undefined;
const db = new SQL.Database(buf);
db.run('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
// ... use db ...
writeFileSync(context.database, Buffer.from(db.export()));
db.close();
```

**`sql.js` needs async init** — `initSqlJs()` returns a Promise. Await it at the top of your handler or in a `setup()` startup hook; don't call it at module scope without top-level await.

## Links

- [Function context reference](https://developers.sinch.com/docs/functions/reference/function-context.md)
- [Context object](https://developers.sinch.com/docs/functions/functions/concepts/context-object.md)
- [Use the cache](https://developers.sinch.com/docs/functions/functions/guides/use-the-cache.md)
