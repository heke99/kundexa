> **Summary — not the spec.** This file orients you and links to the authoritative
> `developers.sinch.com` doc; it may lag, omit fields, or simplify nesting. Do **not**
> copy field names, nesting, encodings, or enums from here into shipped code without
> confirming them in the linked doc. See "Source of Truth" in this skill's SKILL.md.

# Conversation webhooks (Node.js)

Reference for handling inbound Conversation API webhooks in a function. Loaded on-demand from [SKILL.md](../SKILL.md).

This covers the **functions-specific glue** — how inbound webhooks route to your handler and the helpers for reading events. For outbound message bodies (channels, templates, rich cards, carousels), see the **sinch-conversation-api** skill.

**Simple approach** — export a handler function:

```typescript
export async function conversationWebhook(context, request) {
  const body = request.body;
  // handle MESSAGE_INBOUND, MESSAGE_DELIVERY, etc.
  return { statusCode: 200, body: { ok: true } };
}
```

**Structured approach** — extend `ConversationController`:

```typescript
import { ConversationController, getText, getChannel, getContactId } from '@sinch/functions-runtime';

class Bot extends ConversationController {
  async handleMessageInbound(event) {
    const text = getText(event);
    if (!text) return;
    await this.conversation.messages.send({
      sendMessageRequestBody: this.reply(event, `Echo: ${text}`),
    });
  }
}
```

**Message helpers:** `getText`, `getMedia`, `getPostbackData`, `getContactId`, `getConversationId`, `getChannel`, `getIdentity`, `getTo`, `getLocation`, `isTextMessage`, `isMediaMessage`, `isPostback`

**Routing:** the webhook path is `/webhook/conversation` (export name `conversationWebhook`), NOT `/conversation`. The `/webhook/<service>` prefix is special-cased to `<service>Webhook` camelCase.

## Links

- [Handlers (URL-to-export mapping)](https://developers.sinch.com/docs/functions/functions/concepts/handlers.md)
- [Build an SMS responder](https://developers.sinch.com/docs/functions/functions/guides/build-an-sms-responder.md)
