> **Summary — not the spec.** This file orients you and links to the authoritative
> `developers.sinch.com` doc; it may lag, omit fields, or simplify nesting. Do **not**
> copy field names, nesting, encodings, or enums from here into shipped code without
> confirming them in the linked doc. See "Source of Truth" in this skill's SKILL.md.

# SDK Installation (.NET)

## Project-Scoped Auth (Conversation, Numbers, Fax, EST, etc.)

```csharp
using Sinch;

var sinch = new SinchClient("YOUR_PROJECT_ID",
                            "YOUR_KEY_ID",
                            "YOUR_KEY_SECRET");
```

### Setting the Conversation API Region

> With SDK v2 (upcoming), region will be required for Conversation usage. Set region explicitly now to stay forward-compatible.

```csharp
using Sinch;
using Sinch.Conversation;

var sinch = new SinchClient("YOUR_PROJECT_ID",
                            "YOUR_KEY_ID",
                            "YOUR_KEY_SECRET",
                            options => options.ConversationRegion = ConversationRegion.Eu); // Us, Eu, or Br
```

## Application-Scoped Auth (Voice, Verification)

With project credentials:

```csharp
using Sinch;

var sinch = new SinchClient("YOUR_PROJECT_ID",
                            "YOUR_KEY_ID",
                            "YOUR_KEY_SECRET");
var voice = sinch.Voice("YOUR_APP_KEY", "YOUR_APP_SECRET");
var verification = sinch.Verification("YOUR_APP_KEY", "YOUR_APP_SECRET");
```

Voice/Verification only (no project credentials):

```csharp
using Sinch;

var sinch = new SinchClient(null, null, null);
var voice = sinch.Voice("YOUR_APP_KEY", "YOUR_APP_SECRET");
```
