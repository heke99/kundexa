#!/usr/bin/env node
/*
 * EXECUTION TOOL — not a schema reference.
 * Run this to PERFORM a task (e.g. create a webhook, send a test message) when you do not
 * need to write application code. Do NOT copy its payload literals or logic into a new
 * codebase as if they were the API spec — load the authoritative developers.sinch.com doc
 * instead. See "Source of Truth" in this skill's SKILL.md.
 */
/**
 * Send an RCS choice message with a calendar action via Sinch Conversation API.
 *
 * Usage:
 *   node send_calendar_choice.cjs \
 *     --to +15551234567 \
 *     --message "Here is your next spinning exercise Add it to your calendar!" \
 *     --cal-title "Spinning 45 min" \
 *     --event-start "2026-06-20T10:00:00Z" \
 *     --event-end "2026-06-20T10:45:00Z" \
 *     --event-title "Spinning" \
 *     --event-description "45min spinning with the Spinner guy" \
 *     --event-fallback-url "https://www.sinch.com"
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
    var args = {fallbackSms: false};
    for (var i = 2; i < argv.length; i++) {
        switch (argv[i]) {
            case "--to":
                args.to = argv[++i];
                break;
            case "--message":
                args.message = argv[++i];
                break;
            case "--fallback-sms":
                args.fallbackSms = true;
                break;
            case "--sender":
                args.sender = argv[++i];
                break;
            case "--cal-title":
                args.calTitle = argv[++i];
                break;
            case "--event-start":
                args.eventStart = argv[++i];
                break;
            case "--event-end":
                args.eventEnd = argv[++i];
                break;
            case "--event-title":
                args.eventTitle = argv[++i];
                break;
            case "--event-description":
                args.eventDescription = argv[++i];
                break;
            case "--event-fallback-url":
                args.eventFallbackUrl = argv[++i];
                break;
            case "--postback":
                args.postback = argv[++i];
                break;
            case "--help":
                console.log("Usage: node send_calendar_choice.cjs --to PHONE --message TEXT \\");
                console.log('  --cal-title "Button Title" --event-start ISO8601 --event-end ISO8601 \\');
                console.log('  [--event-title TEXT] [--event-description TEXT] [--event-fallback-url URL]');
                process.exit(0);
        }
    }
    if (!args.to || !args.message || !args.eventStart || !args.eventEnd || !args.eventTitle || !args.eventFallbackUrl) {
        console.error("Error: --to, --message, --event-start, --event-end, --event-title, and --event-fallback-url are required");
        process.exit(1);
    }
    return args;
}

function sendRcsCalendarChoice(
    projectId,
    token,
    appId,
    to,
    message,
    calendarEvent,
    region,
    fallbackSms,
    sender,
) {
    var url = client.apiUrl(region, projectId, "messages:send");

    var body = {
        app_id: appId,
        recipient: {
            identified_by: {
                channel_identities: [{ channel: "RCS", identity: to }],
            },
        },
        message: {
            choice_message: {
                text_message: { text: message },
                choices: [
                    {
                        calendar_message: {
                            title: calendarEvent.title,
                            event_start: calendarEvent.eventStart,
                            event_end: calendarEvent.eventEnd,
                            event_title: calendarEvent.eventTitle,
                            event_description: calendarEvent.eventDescription,
                            fallback_url: calendarEvent.fallbackUrl,
                        },
                        postback_data: calendarEvent.postback || "postback_createcalendar",
                    },
                ],
            },
        },
    };

    if (fallbackSms) {
        body.channel_priority_order = ["RCS", "SMS"];
        body.recipient.identified_by.channel_identities.push({
            channel: "SMS",
            identity: to,
        });
        if (sender) {
            body.channel_properties = { SMS_SENDER: sender };
        }
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

    process.stderr.write("Sending RCS calendar choice message to " + args.to + "...\n");
    var result = await sendRcsCalendarChoice(
        projectId,
        token,
        appId,
        args.to,
        args.message,
        {
            title: args.calTitle,
            eventStart: args.eventStart,
            eventEnd: args.eventEnd,
            eventTitle: args.eventTitle,
            eventDescription: args.eventDescription,
            fallbackUrl: args.eventFallbackUrl,
            postback: args.postback,
        },
        region,
    );

    console.log(JSON.stringify(result, null, 2));
}

main().catch(function (err) {
    console.error(err.message);
    process.exit(1);
});


