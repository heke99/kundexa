> **Summary — not the spec.** This file orients you and links to the authoritative
> `developers.sinch.com` doc; it may lag, omit fields, or simplify nesting. Do **not**
> copy field names, nesting, encodings, or enums from here into shipped code without
> confirming them in the linked doc. See "Source of Truth" in this skill's SKILL.md.

# FunctionContext services — Cache, Storage, Database (C#)

Reference for the persistence and state services on `FunctionContext`. Loaded on-demand from [SKILL.md](../SKILL.md).

All three services are injected into every controller via `FunctionContext` (available as `Context.Cache`, `Context.Storage`, `Context.Database`). In development they use local in-memory or filesystem backends; in production they are persistent and durable.

## Cache (`IFunctionCache`)

Key-value store with optional TTL. In dev: in-memory, lost on restart. In prod: persistent, shared across instances.

```csharp
// Store and retrieve
await Context.Cache.Set("session:abc", new { UserId = "u1" }, 1800);  // TTL in seconds
var val = await Context.Cache.Get<MySession>("session:abc");

// Check and delete
if (await Context.Cache.Exists("session:abc"))
    await Context.Cache.Delete("session:abc");

// List all keys
var keys = await Context.Cache.GetKeys();
```

**Default TTL:** 3600 seconds (1 hour). Values are JSON-serialized.

**Common pattern — per-call state across ICE → PIE → DICE:**

```csharp
public override async Task<IActionResult> Ice(IceCallbackModel data)
{
    await Context.Cache.Set($"call:{data.CallId}:cli", data.Cli ?? "unknown", 3600);
    return Ok(new IceSvamletBuilder()
        .Action.RunMenu(MenuTemplates.Business("Acme Corp"))
        .Build());
}

public override async Task<IActionResult> Dice(DiceCallbackModel data)
{
    var cli = await Context.Cache.Get<string>($"call:{data.CallId}:cli");
    Logger.LogInformation("Call from {Cli} ended", cli);
    await Context.Cache.Delete($"call:{data.CallId}:cli");
    return Ok();
}
```

## Storage (`IFunctionStorage`)

File/blob storage for persistent data. In dev: local filesystem (`./storage/`). In prod: S3-backed with local disk read cache.

```csharp
public interface IFunctionStorage
{
    Task WriteAsync(string key, byte[] data);
    Task WriteAsync(string key, string content);
    Task WriteAsync(string key, Stream stream);
    Task<byte[]> ReadAsync(string key);
    Task<string> ReadTextAsync(string key);
    Task<Stream> ReadStreamAsync(string key);
    Task<IReadOnlyList<string>> ListAsync(string? prefix = null);
    Task<bool> ExistsAsync(string key);
    Task DeleteAsync(string key);
}
```

Keys can include path separators (e.g., `"reports/daily.json"`).

```csharp
// Write a file
await Context.Storage.WriteAsync("reports/daily.json", JsonSerializer.Serialize(data));

// Read it back
var content = await Context.Storage.ReadTextAsync("reports/daily.json");

// List files under a prefix
var files = await Context.Storage.ListAsync("reports/");

// Check existence and delete
if (await Context.Storage.ExistsAsync("reports/old.json"))
    await Context.Storage.DeleteAsync("reports/old.json");

// Stream-based for large files
using var stream = await Context.Storage.ReadStreamAsync("large-file.bin");
```

## Database (`IFunctionDatabase`)

`Context.Database.ConnectionString` gives you a SQLite connection string. Bring your own SQLite library. In production, the database is durable and replicated automatically — no code changes.

### Usage with Microsoft.Data.Sqlite

```bash
dotnet add package Microsoft.Data.Sqlite
```

```csharp
using Microsoft.Data.Sqlite;

public override async Task<IActionResult> Ice(IceCallbackModel data)
{
    using var conn = new SqliteConnection(Context.Database.ConnectionString);
    conn.Open();

    using var cmd = conn.CreateCommand();
    cmd.CommandText = "CREATE TABLE IF NOT EXISTS call_log (id INTEGER PRIMARY KEY, caller TEXT, ts INTEGER)";
    cmd.ExecuteNonQuery();

    cmd.CommandText = "INSERT INTO call_log (caller, ts) VALUES ($caller, $ts)";
    cmd.Parameters.AddWithValue("$caller", data.Cli ?? "unknown");
    cmd.Parameters.AddWithValue("$ts", DateTimeOffset.UtcNow.ToUnixTimeSeconds());
    cmd.ExecuteNonQuery();

    return Ok(new IceSvamletBuilder().Instructions.Say("Call logged.").Action.Hangup().Build());
}
```

### Usage with Dapper

```bash
dotnet add package Dapper
dotnet add package Microsoft.Data.Sqlite
```

```csharp
using Dapper;
using Microsoft.Data.Sqlite;

using var conn = new SqliteConnection(Context.Database.ConnectionString);
var calls = await conn.QueryAsync<CallRecord>("SELECT * FROM call_log ORDER BY ts DESC LIMIT 10");
```

## Related

- [.NET skill](../SKILL.md) — full runtime overview
- [svaml-builders.md](svaml-builders.md) — voice response builders
- [conversation-webhooks.md](conversation-webhooks.md) — messaging webhooks
- [Function context reference](https://developers.sinch.com/docs/functions/reference/function-context.md)
