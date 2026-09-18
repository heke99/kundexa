#!/usr/bin/env node
/*
 * EXECUTION TOOL — not a schema reference.
 * Run this to PERFORM a task (e.g. create a webhook, send a test message) when you do not
 * need to write application code. Do NOT copy its payload literals or logic into a new
 * codebase as if they were the API spec — load the authoritative developers.sinch.com doc
 * instead. See "Source of Truth" in this skill's SKILL.md.
 */
/**
 * Send an RCS card message via Sinch Conversation API.
 *
 * Usage:
 *   node send_card.cjs --to +15551234567 --title "Sale" --description "50% off" --image-url "https://..." --choices "Shop Now,Learn More"
 *   node send_card.cjs --to +15551234567 --title "Product" --description "Amazing features" --image-url "https://..." --fallback-sms
 *   node send_card.cjs --to +15551234567 --title "Deal" --description "Tap to open" --image-url "https://..." --orientation HORIZONTAL --alignment RIGHT
 *   node send_card.cjs --to +15551234567 --title "Webview" --description "Opens in tall webview" --image-url "https://..." --webview-mode TALL
 *
 * Environment variables (required):
 *   SINCH_PROJECT_ID   - Sinch project ID
 *   SINCH_KEY_ID       - Access key ID
 *   SINCH_KEY_SECRET   - Access key secret
 *   SINCH_APP_ID       - Conversation API app ID
 *
 * Environment variables (optional):
 *   SINCH_REGION       - API region: us, eu, or br (default: us)
 */

var client = require("./common/sinch_client.cjs");

function parseArgs(argv) {
  var args = { fallbackSms: false };
  for (var i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--to":
        args.to = argv[++i];
        break;
      case "--title":
        args.title = argv[++i];
        break;
      case "--description":
        args.description = argv[++i];
        break;
      case "--image-url":
        args.imageUrl = argv[++i];
        break;
      case "--choices":
        args.choices = argv[++i].split(",");
        break;
      case "--fallback-sms":
        args.fallbackSms = true;
        break;
      case "--sender":
        args.sender = argv[++i];
        break;
      case "--orientation":
        args.orientation = argv[++i];
        break;
      case "--alignment":
        args.alignment = argv[++i];
        break;
      case "--webview-mode":
        args.webviewMode = argv[++i];
        break;
      case "--help":
        console.log(
          'Usage: node send_card.cjs --to PHONE --title TEXT --description TEXT --image-url URL' +
          ' [--choices "Choice1,Choice2"] [--fallback-sms] [--sender NUMBER]' +
          ' [--orientation HORIZONTAL|VERTICAL] [--alignment LEFT|RIGHT] [--webview-mode TALL|FULL|HALF]',
        );
        process.exit(0);
    }
  }
  if (!args.to || !args.title || !args.description || !args.imageUrl) {
    console.error(
      "Error: --to, --title, --description, and --image-url are required",
    );
    console.error(
      'Usage: node send_card.cjs --to PHONE --title TEXT --description TEXT --image-url URL' +
      ' [--choices "Choice1,Choice2"] [--orientation HORIZONTAL|VERTICAL] [--alignment LEFT|RIGHT] [--webview-mode TALL|FULL|HALF]',
    );
    process.exit(1);
  }
  return args;
}

function sendRcsCard(
  projectId,
  token,
  appId,
  to,
  title,
  description,
  imageUrl,
  choices,
  region,
  fallbackSms,
  sender,
  orientation,
  alignment,
  webviewMode,
) {
  var url = client.apiUrl(region, projectId, "messages:send");

  var choicesArray = [];
  if (choices && choices.length > 0) {
    choicesArray = choices.map(function (choice) {
      return {
        text_message: { text: choice },
        postback_data: choice.toLowerCase().replace(/ /g, "_"),
      };
    });
  }

  var body = {
    app_id: appId,
    recipient: {
      identified_by: {
        channel_identities: [{ channel: "RCS", identity: to }],
      },
    },
    message: {
      card_message: {
        title: title,
        description: description,
        media_message: { url: imageUrl },
        choices: choicesArray,
      },
    },
  };

  // Build channel_properties by merging all applicable properties
  var channelProperties = {};

  if (orientation) {
    channelProperties.RCS_CARD_ORIENTATION = orientation;
  }
  if (alignment) {
    channelProperties.RCS_CARD_THUMBNAIL_IMAGE_ALIGNMENT = alignment;
  }
  if (webviewMode) {
    channelProperties.RCS_WEBVIEW_MODE = webviewMode;
  }

  if (fallbackSms) {
    body.channel_priority_order = ["RCS", "SMS"];
    body.recipient.identified_by.channel_identities.push({
      channel: "SMS",
      identity: to,
    });
    if (sender) {
      channelProperties.SMS_SENDER = sender;
    }
  }

  if (Object.keys(channelProperties).length > 0) {
    body.channel_properties = channelProperties;
  }

  var data = JSON.stringify(body);
  return client.httpRequest(
    url,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
    },
    data,
  );
}

async function main() {
  var args = parseArgs(process.argv);

  var projectId = client.getEnv("SINCH_PROJECT_ID");
  var keyId = client.getEnv("SINCH_KEY_ID");
  var keySecret = client.getEnv("SINCH_KEY_SECRET");
  var appId = client.getEnv("SINCH_APP_ID");
  var region = client.getEnv("SINCH_REGION", "us");

  process.stderr.write("Authenticating...\n");
  var token = await client.getAccessToken(keyId, keySecret);

  process.stderr.write("Sending RCS card message to " + args.to + "...\n");
  var result = await sendRcsCard(
    projectId,
    token,
    appId,
    args.to,
    args.title,
    args.description,
    args.imageUrl,
    args.choices,
    region,
    args.fallbackSms,
    args.sender,
    args.orientation,
    args.alignment,
    args.webviewMode,
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch(function (err) {
  console.error(err.message);
  process.exit(1);
});
