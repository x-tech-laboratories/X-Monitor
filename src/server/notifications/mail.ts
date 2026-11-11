// Channels that hand a notification to another delivery system: email over SMTP, and Apprise.

// ── Imports ──────────────────────────────────────────────────────────────────

import { apprise_urls, send_apprise, type AppriseType, type ProgramRunner } from "@x-tech-laboratories/x-libs/server/notify/apprise";
import { mail_settings, send_mail, type MailSettings, type TransportFactory } from "@x-tech-laboratories/x-libs/server/notify/mail";

import { Channel, type ChannelConfig, type Message } from "./channels.ts";

// ── Text ─────────────────────────────────────────────────────────────────────

// A notification's body with its link on a line of its own.
export function text(message: Message): string {
  return [message.body, message.url ?? ""].filter((part) => part).join("\n\n");
}

// ── SMTP ─────────────────────────────────────────────────────────────────────

// Emails each notification.
export class SmtpChannel extends Channel {
  static override readonly TYPE = "smtp";
  readonly settings: MailSettings;
  // The transport mail goes through; a test hands in its own.
  create_transport: TransportFactory | undefined = undefined;

  constructor(channel_id: string, config: ChannelConfig) {
    super(channel_id, config);
    this.settings = mail_settings(config);
  }

  // The subject and text one notification becomes, before the subject prefix.
  email(message: Message): { subject: string; text: string } {
    return { subject: message.title, text: text(message) };
  }

  async send(message: Message): Promise<void> {
    await send_mail(this.settings, this.email(message), this.create_transport);
  }
}

// ── Apprise ──────────────────────────────────────────────────────────────────

// Sends each notification through Apprise, which reaches most chat, push and SMS services.
export class AppriseChannel extends Channel {
  static override readonly TYPE = "apprise";
  readonly urls: string[];
  // Runs the apprise program; a test hands in its own.
  run: ProgramRunner | undefined = undefined;

  constructor(channel_id: string, config: ChannelConfig) {
    super(channel_id, config);
    this.urls = apprise_urls(config);
  }

  // Apprise's severity for a notification, which some services show as a color or icon.
  notify_type(message: Message): AppriseType {
    if (message.clears) return "success";
    if (message.kind === "flapping") return "warning";
    return message.status === "failed" ? "failure" : message.status === "warning" ? "warning" : "info";
  }

  async send(message: Message): Promise<void> {
    await send_apprise(this.urls, { title: message.title, body: text(message) || message.title, type: this.notify_type(message) }, { run: this.run });
  }
}
