> **Summary — not the spec.** This file orients you and links to the authoritative
> `developers.sinch.com` doc; it may lag, omit fields, or simplify nesting. Do **not**
> copy field names, nesting, encodings, or enums from here into shipped code without
> confirming them in the linked doc. See "Source of Truth" in this skill's SKILL.md.

# SVAML builders and IVR menus (C#)

Reference for the full `IceSvamletBuilder` / `PieSvamletBuilder` / `AceSvamletBuilder` APIs and IVR menu construction. Loaded on-demand from [SKILL.md](../SKILL.md).

## Builder chain pattern

**Critical:** always `Instructions.*` → `Action.*` → `Build()`. This is different from Node.js (which uses a flat chain).

```csharp
using SinchFunctions.Utils;

// ICE: Instructions → Action → Build
var response = new IceSvamletBuilder()
    .Instructions.Say("Welcome!")
    .Action.ConnectPstn("+15551234567")
    .Build();
return Ok(response);

// With full options
var response = new IceSvamletBuilder()
    .Instructions.Say("Connecting you now.")
    .Instructions.SetCookie("language", "en-US")
    .Action.ConnectPstn("+15551234567", new ConnectPstnOptions
    {
        Cli = data.Cli,
        MaxDuration = 3600,
        ConnectTimeout = 30,
        Amd = new { enabled = true },
    })
    .Build();

// ACE: Continue or Hangup only
return Ok(new AceSvamletBuilder().Action.Continue().Build());

// PIE: same as ICE
return Ok(new PieSvamletBuilder()
    .Instructions.Say("Connecting to sales.")
    .Action.ConnectPstn("+15551111111")
    .Build());
```

## Available actions by builder

| Builder | Available actions |
|---|---|
| `IceSvamletBuilder` | `Hangup()`, `Continue()`, `ConnectPstn()`, `ConnectSip()`, `ConnectMxp()`, `ConnectConf()`, `ConnectAgent()`, `RunMenu()`, `Park()` |
| `PieSvamletBuilder` | `Hangup()`, `Continue()`, `ConnectPstn()`, `ConnectSip()`, `ConnectMxp()`, `ConnectConf()`, `ConnectAgent()`, `RunMenu()`, `Park()` |
| `AceSvamletBuilder` | `Hangup()`, `Continue()` **only** — you cannot connect calls from ACE |
| `DiceSvamletBuilder` | Informational only; just return `Ok()` |

## Instructions (work on all builders)

| Method | Purpose |
|---|---|
| `Say(text, locale?)` | Text-to-speech. Default locale `"en-US"` |
| `PlayFiles(files, locale?)` | Play audio files in sequence |
| `Answer()` | Explicitly answer the call (ICE only) |
| `SetCookie(key, value)` | Store state across callbacks without a cache lookup |
| `SendDtmf(dtmf)` | Send DTMF tones after connecting |
| `StartRecording(opts)` | Start call recording |
| `StopRecording()` | Stop an active recording |

Instructions chain: `.Instructions.Say(...).Instructions.SetCookie(...)`. Each `Instructions.*` call returns a builder that lets you add more instructions OR switch to `Action.*`.

## IVR menus

```csharp
using SinchFunctions.Utils;

// Pre-built template
return Ok(new IceSvamletBuilder()
    .Action.RunMenu(MenuTemplates.Business("Acme Corp"))
    .Build());

// Custom menu
var menu = new MenuBuilder()
    .Prompt("Press 1 for sales, press 2 for support.")
    .Option("1", "return(sales)")
    .Option("2", "return(support)")
    .Timeout(8000)
    .MaxDigits(1)
    .Build();

return Ok(new IceSvamletBuilder().Action.RunMenu(menu).Build());
```

**Menu templates** (from `SinchFunctions.Utils.MenuTemplates`):

| Template | Result values |
|---|---|
| `Business(companyName)` | `"sales"`, `"support"`, `"operator"` |
| `YesNo(question)` | `"yes"`, `"no"` |
| `Language(languages)` | language value strings |
| `AfterHours(companyName, businessHours)` | `"voicemail"`, `"website"`, `"emergency"` |
| `RecordingConsent()` | `"consent"`, `"no_consent"` |
| `CallbackRequest(estimatedWaitTime)` | `"hold"`, `"callback"` |
| `CustomerService()` | `"billing"`, `"technical"`, `"new_service"`, `"agent"` |
| `SatisfactionSurvey()` | `"excellent"`, `"good"`, `"fair"`, `"poor"` |

## Handling menu results in PIE

```csharp
public override async Task<IActionResult> Pie(PieCallbackModel data)
{
    var result = data.MenuResult;

    if (result?.Type is "timeout" or "hangup")
        return Ok(new PieSvamletBuilder().Instructions.Say("Goodbye!").Action.Hangup().Build());

    return result?.Value switch
    {
        "sales" => Ok(new PieSvamletBuilder()
            .Instructions.Say("Connecting to sales.")
            .Action.ConnectPstn("+15551111111").Build()),
        "support" => Ok(new PieSvamletBuilder()
            .Instructions.Say("Connecting to support.")
            .Action.ConnectPstn("+15552222222").Build()),
        _ => Ok(new PieSvamletBuilder()
            .Instructions.Say("Invalid selection.")
            .Action.Continue().Build()),
    };
}
```

**`MenuResult.Type` values:** `"return"` (user pressed a key), `"sequence"` (multi-digit collected), `"timeout"`, `"hangup"`, `"invalidinput"`.

## Error helpers

```csharp
using SinchFunctions.Utils;

VoiceErrorHelper.CreateErrorResponse("Service unavailable.");
VoiceErrorHelper.ServiceUnavailable();   // default message
VoiceErrorHelper.InvalidInput();          // PIE: say + continue
```

## Related

- [.NET skill](../SKILL.md) — full runtime overview
- [context-services.md](context-services.md) — Cache / Storage / Database
- [conversation-webhooks.md](conversation-webhooks.md) — `SinchConversationController` patterns
- [SVAML cheat sheet](https://developers.sinch.com/docs/functions/reference/svaml-cheatsheet.md)
- [Voice callbacks concept](https://developers.sinch.com/docs/functions/functions/concepts/voice-callbacks.md)
