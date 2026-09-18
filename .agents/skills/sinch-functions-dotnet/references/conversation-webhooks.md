> **Summary — not the spec.** This file orients you and links to the authoritative
> `developers.sinch.com` doc; it may lag, omit fields, or simplify nesting. Do **not**
> copy field names, nesting, encodings, or enums from here into shipped code without
> confirming them in the linked doc. See "Source of Truth" in this skill's SKILL.md.

# Conversation webhooks (C#)

Reference for `SinchConversationController` and related helpers. Loaded on-demand from [SKILL.md](../SKILL.md).

## SinchConversationController

Extend this base class to handle inbound Conversation API webhooks (SMS, WhatsApp, RCS, Messenger, etc.). All handler methods are **optional** — override only the events you need; unhandled events default to returning `Ok()`.

```csharp
public class MyConversationController : SinchConversationController
{
    public override async Task<IActionResult> MessageInbound(MessageInboundEvent callback)
    {
        var text = callback.GetText();
        if (text == "hello")
        {
            var reply = Reply(callback, "Hi there!");
            await Context.Conversation!.Messages.Send(reply);
        }
        return Ok();
    }
}
```

**Available override methods:**

| Method | Fired when |
|---|---|
| `MessageInbound(MessageInboundEvent)` | A user sends a message (most common) |
| `MessageDelivery(MessageDeliveryEvent)` | Delivery status changes (QUEUED → DELIVERED / FAILED) |
| `EventInbound(EventInboundEvent)` | Typing indicators, read receipts, etc. |
| `ConversationStart(ConversationStartEvent)` | New conversation created |
| `ConversationStop(ConversationStopEvent)` | Conversation ended |

## Extension methods on `MessageInboundEvent`

All extension methods are in the `SinchFunctions.Utils` namespace:

```csharp
using SinchFunctions.Utils;

callback.GetText();            // string? — text content
callback.GetMedia();            // media message object (images, video, etc.)
callback.GetPostbackData();     // postback button data
callback.GetContactId();        // Sinch contact ID
callback.GetConversationId();   // conversation ID
callback.GetChannel();          // "SMS", "WHATSAPP", "MESSENGER", etc.
callback.GetIdentity();         // sender's phone/PSID
callback.GetTo();               // your Sinch number
callback.GetLocation();         // location share data

callback.IsTextMessage();       // bool
callback.IsMediaMessage();      // bool
callback.IsPostback();          // bool
```

## Sending replies

### Built-in `Reply()` helper

The `SinchConversationController` base class provides `Reply(inbound, text)` which auto-fills `app_id`, recipient channel/identity, and sender ID from the inbound event:

```csharp
var reply = Reply(callback, "Thanks for your message!");
await Context.Conversation!.Messages.Send(reply);
```

Other base-class helpers: `CreateMessage()`, `CreateMessage(inbound)`.

### `ConversationMessage` static helpers

Namespace: `SinchFunctions.Utils`

```csharp
using SinchFunctions.Utils;

// Reply to an inbound message
ConversationMessage.TextReply(inbound, "Thanks!", fromNumber);

// Send to a specific channel (no inbound needed)
ConversationMessage.CreateSms(appId, "+15551234567", "Hello!", smsSender);
ConversationMessage.CreateWhatsApp(appId, "+15551234567", "Hello!");
```

## Multi-channel pattern

One controller handles all channels; dispatch on `GetChannel()`:

```csharp
public class SupportBot : SinchConversationController
{
    public override async Task<IActionResult> MessageInbound(MessageInboundEvent callback)
    {
        if (!callback.IsTextMessage()) return Ok();

        var text = callback.GetText()?.ToLower().Trim();
        var channel = callback.GetChannel();
        var contactId = callback.GetContactId();

        Logger.LogInformation("[{Channel}] {ContactId}: {Text}", channel, contactId, text);

        string reply = text switch
        {
            var t when t!.Contains("hours") => "We are open Mon-Fri 9am-5pm EST.",
            var t when t!.Contains("help")  => "Commands: hours, status, human",
            var t when t!.Contains("human") => "Connecting you to an agent...",
            _ => "Hi! Reply \"help\" for available commands."
        };

        await Context.Conversation!.Messages.Send(Reply(callback, reply));
        return Ok();
    }

    public override async Task<IActionResult> MessageDelivery(MessageDeliveryEvent callback)
    {
        var status = callback.MessageDeliveryReport?.Status;
        if (status == "FAILED")
            Logger.LogError("Delivery failed: {Report}", callback.MessageDeliveryReport);
        return Ok();
    }
}
```

## Required environment variables

| Variable | Description |
|---|---|
| `CONVERSATION_APP_ID` | Your Sinch Conversation App ID |
| `PROJECT_ID` | Sinch project ID |
| `PROJECT_ID_API_KEY` | Project API key ID |
| `PROJECT_ID_API_SECRET` | Project API key secret |
| `CONVERSATION_REGION` | `"US"` (default), `"EU"`, or `"BR"` |

Store secrets via the CLI:

```bash
sinch secrets add CONVERSATION_APP_ID your-app-id
```

## Related

- [.NET skill](../SKILL.md) — full runtime overview
- [svaml-builders.md](svaml-builders.md) — voice response builders
- [context-services.md](context-services.md) — Cache / Storage / Database
- [Build an SMS responder guide](https://developers.sinch.com/docs/functions/functions/guides/build-an-sms-responder.md)
- [Conversation API callbacks](https://developers.sinch.com/docs/conversation/callbacks.md)
