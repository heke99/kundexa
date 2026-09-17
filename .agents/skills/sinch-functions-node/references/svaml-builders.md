> **Summary — not the spec.** This file orients you and links to the authoritative
> `developers.sinch.com` doc; it may lag, omit fields, or simplify nesting. Do **not**
> copy field names, nesting, encodings, or enums from here into shipped code without
> confirming them in the linked doc. See "Source of Truth" in this skill's SKILL.md.

# SVAML builders and IVR menus (Node.js)

Reference for the full `IceSvamlBuilder` / `AceSvamlBuilder` / `PieSvamlBuilder` APIs and IVR menu construction. Loaded on-demand from [SKILL.md](../SKILL.md).

## SVAML builders

Always use builders, never raw JSON. Each builder has `.build()` as the final call.

```typescript
import { IceSvamlBuilder, AceSvamlBuilder, PieSvamlBuilder } from '@sinch/functions-runtime';

// ICE — full action set
return new IceSvamlBuilder()
  .say('Welcome!')                     // TTS instruction
  .connectPstn('+15551234567', {       // action: connect to phone
    cli: data.cli,                     // show caller's number
    enableAce: true,                   // fire ACE when answered
    amd: { enabled: true },           // answering machine detection
  })
  .build();

// ACE — continue or hangup only
return new AceSvamlBuilder().continue().build();

// PIE — same actions as ICE (except answer)
return new PieSvamlBuilder().say('Connecting.').connectPstn('+15551111111').build();
```

**ICE actions:** `hangup()`, `continue()`, `connectPstn()`, `connectSip()`, `connectMxp()`, `connectConf()`, `connectAgent()`, `runMenu()`, `park()`

**PIE actions (subset of ICE):** `hangup()`, `continue()`, `connectPstn()`, `runMenu()`, `park()`, `connectAgent()`

**ACE actions (very restricted):** `hangup()`, `continue()` only — you cannot connect calls from ACE

**Instructions (chainable, work on all three builders):** `say(text, locale?)`, `play(url)`, `playFiles(urls)`, `setCookie(key, value)`, `answer()` (ICE only), `sendDtmf(digits)`, `startRecording(opts)`, `stopRecording()`

## IVR menus

```typescript
import { createMenu, MenuTemplates } from '@sinch/functions-runtime';

// Pre-built template
return new IceSvamlBuilder().runMenu(MenuTemplates.business('Acme Corp')).build();

// Custom menu
const menu = createMenu()
  .prompt('Press 1 for sales, press 2 for support.')
  .option('1', 'return(sales)')
  .option('2', 'return(support)')
  .timeout(8000)
  .maxDigits(1)
  .build();

return new IceSvamlBuilder().runMenu(menu).build();
```

**Templates:** `business`, `yesNo`, `language`, `afterHours`, `recordingConsent`, `numericInput`

Handle menu results in PIE:

```typescript
async pie(context, data) {
  const { type, value } = data.menuResult ?? {};
  if (type === 'timeout' || type === 'hangup') {
    return new PieSvamlBuilder().say('Goodbye!').hangup().build();
  }
  switch (value) {
    case 'sales': return new PieSvamlBuilder().connectPstn('+15551111111').build();
    case 'support': return new PieSvamlBuilder().connectPstn('+15552222222').build();
    default: return new PieSvamlBuilder().say('Invalid.').continue().build();
  }
}
```

## Links

- [SVAML cheat sheet](https://developers.sinch.com/docs/functions/reference/svaml-cheatsheet.md)
- [Voice callbacks (ICE/ACE/PIE/DICE)](https://developers.sinch.com/docs/functions/functions/concepts/voice-callbacks.md)
- [Build an IVR](https://developers.sinch.com/docs/functions/functions/guides/build-an-ivr.md)
